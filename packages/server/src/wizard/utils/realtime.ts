// oxlint-disable import/exports-last
import type { ChangeEvent, Database, QueryHandle, TableDef, WatchDelta } from 'db:core'
import { DbErrors } from 'db:core'
import type { Action, ClientFrame, Meta, ServerFrame, SocketHandle, SocketRoute } from 'server:core'
import { Broker, clientFrame, defineAction, stream, useRequest } from 'server:core'
import { requestId } from 'server:utils'
import type { Flow, Operation, Scope, Subscription, Task } from 'std:effect'
import { attempt, ensure, operation, sleep } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'
import { z } from 'zod'

import { SSE_WATCH_ID, WATCH_DEBOUNCE_MS } from '../const'
import { WizardErrors } from '../errors'
import { database, listQuery, runAccess } from '../internal'
import type { Wizard } from '../types'

const DECODER = new TextDecoder()

type WatchFrame = Extract<ClientFrame, { event: 'watch' }>
type FrameStep = IteratorResult<ServerFrame, void>

const DONE: FrameStep = { done: true, value: undefined }

const emit = (frame: ServerFrame): FrameStep => ({ done: false, value: frame })

let liveWatches = 0

/**
 * Whitebox diagnostics: the number of ESTABLISHED watch pipelines (db feed subscribed) currently
 * live — WS and SSE alike. A pipeline counts from the moment its db subscription is created until
 * the consuming task ends (unwatch, socket close, SSE disconnect, terminal reset/error), so a
 * value that stays elevated across idle periods indicates a leaked watcher. Test-facing only.
 */
export const realtimeWatchCount = (): number => liveWatches

const trackWatch = operation(function* () {
  liveWatches += 1

  yield* ensure(() => {
    liveWatches -= 1
  })
})

const send = operation(function* (socket: SocketHandle, frame: ServerFrame) {
  socket.send(yield* JsonCodec.actions.stringify(frame))
})

const sendError = operation(function* (input: {
  readonly socket: SocketHandle
  readonly id: string
  readonly error: string
  readonly message: string
}) {
  yield* send(input.socket, {
    type: 'error',
    id: input.id,
    error: input.error,
    message: input.message,
    requestId: yield* requestId(),
  })
})

const parseFrame = operation(function* (data: string | Uint8Array) {
  const text = typeof data === 'string' ? data : DECODER.decode(data)
  const raw = yield* attempt(() => JsonCodec.actions.parse(text))

  if (isFailure(raw)) {
    return null
  }

  const checked = clientFrame.safeParse(raw.value)

  return checked.success ? checked.data : null
})

/** Everything one watch needs, shared by the WS route and the SSE action. */
export interface OpenWatchInput {
  readonly source: Wizard.WatchSource
  /** The watch id stamped on every outgoing frame. */
  readonly id: string
  readonly fn: string
  readonly args: unknown
  readonly since?: number | undefined
  /** Caller headers the access guard sees (socket handshake / SSE request). */
  readonly meta: Meta
}

interface FramePump {
  /** Produce the next frame; `null` when the underlying feed closed (→ reset). */
  readonly pull: () => Operation<ServerFrame | null>
  /** True once the watch went live (initial state delivered or silently resumed). */
  readonly live: () => boolean
}

/**
 * Wrap one watch pump into the terminal-frame contract shared by WS and SSE: the flow NEVER
 * raises. A failure (or feed close) after the watch is live ends it with a `reset` frame — the
 * client drops its `since` and resubscribes for a fresh `sync`; before that it ends with an
 * `error` frame (fatal for the watch id). The db subscription is established lazily on the first
 * `next()`, i.e. inside the CONSUMER's task — halting that task (unwatch, socket close, SSE
 * disconnect) tears it down.
 */
const frameFlow = (id: string, create: () => FramePump): Flow<ServerFrame, void> => ({
  *[Symbol.iterator]() {
    const pump = create()
    let ended = false

    const next = operation(function* () {
      if (ended) {
        return DONE
      }

      const outcome = yield* attempt(pump.pull)

      if (!isFailure(outcome) && outcome.value !== null) {
        return emit(outcome.value)
      }

      ended = true

      if (isFailure(outcome) && !pump.live()) {
        return emit({
          type: 'error',
          id,
          error: String(outcome.error),
          message: outcome.message,
          requestId: yield* requestId(),
        })
      }

      return emit({ type: 'reset', id })
    })

    return { next }
  },
})

/**
 * A crud `list` watch: the SAME sanitized pipeline as REST, then a db delta watch. The first
 * emission (everything as `added`) becomes a `sync` frame — unless the client's `since` already
 * matches its version, in which case it is suppressed (the resume path) and only genuine diffs
 * follow as `delta` frames. A stale `since` therefore self-heals with a fresh full `sync`.
 */
const listFrames = (input: OpenWatchInput, handle: QueryHandle<AnyType>): Flow<ServerFrame, void> =>
  frameFlow(input.id, () => {
    let feed: Subscription<WatchDelta<AnyType>, never> | null = null
    let first = true
    let live = false

    const open = operation(function* () {
      yield* trackWatch()

      const created = yield* handle.watch({ mode: 'delta' })

      feed = created

      return created
    })

    const pull = operation(function* () {
      const active = feed ?? (yield* open())

      for (;;) {
        const step = yield* active.next()

        if (step.done) {
          return null
        }

        const delta = step.value

        if (first) {
          first = false
          live = true

          // the client already reflects this exact version — resume silently, diffs follow
          if (input.since !== undefined && delta.version === input.since) {
            continue
          }

          const frame: ServerFrame = {
            type: 'sync',
            id: input.id,
            version: delta.version,
            rows: [...delta.added],
          }

          return frame
        }

        const frame: ServerFrame = {
          type: 'delta',
          id: input.id,
          version: delta.version,
          added: [...delta.added],
          changed: [...delta.changed],
          removed: [...delta.removed],
        }

        return frame
      }
    })

    return { pull, live: () => live }
  })

interface CustomFeed {
  readonly db: Database
  readonly changes: Subscription<ChangeEvent, never>
}

/**
 * A `query({ watch: true })` watch: every relevant table change (burst-coalesced) re-runs the fn
 * through the broker (validation, access guard, policies and trace all apply) and pushes a `sync`
 * frame whose `rows` is `[value]`. With a current `since` the initial compute is skipped (resume).
 */
const customFrames = (input: OpenWatchInput): Flow<ServerFrame, void> =>
  frameFlow(input.id, () => {
    const table = input.source.table as TableDef
    let feed: CustomFeed | null = null
    let seen = 0
    let opening = true
    let live = false

    const compute = () =>
      Broker.actions.call(input.source.name, input.fn, input.args, {
        meta: input.meta,
        origin: 'external',
      })

    const open = operation(function* () {
      yield* trackWatch()

      const db = yield* database()
      const changes = yield* db.changes(table.name)
      const created: CustomFeed = { db, changes }

      feed = created
      seen = db.version(table.name)

      return created
    })

    const pull = operation(function* () {
      const active = feed ?? (yield* open())

      if (opening) {
        opening = false

        if (input.since === undefined || input.since !== seen) {
          const value = yield* compute()

          seen = active.db.version(table.name)
          live = true

          const frame: ServerFrame = { type: 'sync', id: input.id, version: seen, rows: [value] }

          return frame
        }

        live = true
      }

      for (;;) {
        const step = yield* active.changes.next()

        if (step.done) {
          return null
        }

        if (step.value.version <= seen) {
          continue
        }

        yield* sleep(WATCH_DEBOUNCE_MS)

        const value = yield* compute()

        seen = active.db.version(table.name)

        const frame: ServerFrame = { type: 'sync', id: input.id, version: seen, rows: [value] }

        return frame
      }
    })

    return { pull, live: () => live }
  })

/**
 * SUBSCRIBE PHASE of one realtime watch — the single pipeline behind BOTH the WS route and the
 * SSE action: validate the fn is watchable, run its access guard, sanitize list args. Failures
 * RAISE here (the WS pump folds them into an `error` frame; the SSE action lets them become the
 * HTTP error response). The returned flow then follows the {@link frameFlow} contract: it never
 * raises — `sync`/`delta` frames while healthy, a terminal `error` frame if it breaks before
 * going live, a terminal `reset` frame if a LIVE watch breaks (transient recompute failure, feed
 * close) — the client resubscribes without `since`.
 */
export const openWatch = operation(function* (input: OpenWatchInput) {
  const recipe = input.source.watchable.get(input.fn)

  if (!recipe) {
    return yield* fail(
      WizardErrors.NotWatchable,
      `"${input.source.name}.${input.fn}" is not watchable`,
    )
  }

  yield* runAccess({
    access: recipe.access,
    service: input.source.name,
    fn: input.fn,
    args: input.args,
    meta: input.meta,
  })

  if (recipe.kind === 'list') {
    const handle = yield* listQuery(recipe.pipeline, (input.args ?? {}) as Record<string, unknown>)

    return listFrames(input, handle)
  }

  return customFrames(input)
})

interface WatchInput {
  readonly meta: Wizard.ResourceMeta
  readonly frame: WatchFrame
  readonly socket: SocketHandle
}

/** One WS subscription: open → pump frames to the socket. Subscribe failures → an error frame. */
const runWatch = operation(function* (input: WatchInput) {
  const outcome = yield* attempt(function* () {
    const frames = yield* openWatch({
      source: input.meta,
      id: input.frame.id,
      fn: input.frame.fn,
      args: input.frame.args,
      since: input.frame.since,
      meta: input.socket.meta,
    })
    const subscription = yield* frames

    for (;;) {
      const step = yield* subscription.next()

      if (step.done) {
        return
      }

      yield* send(input.socket, step.value)
    }
  })

  if (isFailure(outcome)) {
    yield* attempt(() =>
      sendError({
        socket: input.socket,
        id: input.frame.id,
        error: String(outcome.error),
        message: outcome.message,
      }),
    )
  }
})

export interface RealtimeInput {
  readonly meta: Wizard.ResourceMeta
  /** The long-lived scope watch tasks run on (each halted on unwatch / socket close). */
  readonly scope: Scope
}

/**
 * The `/<resource>/_realtime` WebSocket route: `watch`/`unwatch` frames in, `sync`/`delta`/
 * `reset`/`error` frames out (the `server:core` frame vocabulary). Registered by `installWizard`
 * for every table-backed resource. A watch that ends with a terminal frame (`reset`/`error`) is
 * also cleaned out of the per-socket task map.
 */
export const createRealtimeRoute = ({ meta, scope }: RealtimeInput): SocketRoute => {
  const sockets = new Map<string, Map<string, Task<AnyType>>>()

  return {
    message: operation(function* (socket, data) {
      const frame = yield* parseFrame(data)

      if (!frame) {
        yield* sendError({
          socket,
          id: '',
          error: WizardErrors.BadFrame,
          message: 'malformed realtime frame',
        })

        return
      }

      const tasks = sockets.get(socket.id) ?? new Map<string, Task<AnyType>>()

      sockets.set(socket.id, tasks)

      const existing = tasks.get(frame.id)

      if (existing) {
        tasks.delete(frame.id)

        yield* existing.halt()
      }

      if (frame.event === 'unwatch') {
        return
      }

      // detached: a watch failure settles its own task and never touches the shared scope
      const task = scope.run(() => runWatch({ meta, frame, socket }), { detached: true })

      tasks.set(frame.id, task)

      // task promises resolve a Result and never reject — safe fire-and-forget map cleanup
      void task.then(() => (tasks.get(frame.id) === task ? tasks.delete(frame.id) : false))
    }),

    close: operation(function* (socket) {
      const tasks = sockets.get(socket.id)

      sockets.delete(socket.id)

      if (!tasks) {
        return
      }

      for (const task of tasks.values()) {
        yield* task.halt()
      }
    }),
  }
}

const sseQuery = z.object({
  fn: z.string(),
  args: z.string().optional(),
  since: z.string().regex(/^\d+$/u).optional(),
})

const parseSseArgs = operation(function* (raw: string | undefined) {
  if (raw === undefined || raw === '') {
    return undefined
  }

  const parsed = yield* attempt(() => JsonCodec.actions.parse(raw))

  if (isFailure(parsed)) {
    return yield* fail(WizardErrors.BadFrame, 'the "args" query parameter is not valid JSON')
  }

  return parsed.value
})

/**
 * The SSE realtime flavor — `GET /<resource>/_realtime/sse?fn=<fn>&args=<json>&since=<version>`
 * for environments without WebSocket (EventSource-only clients, WS-blocking proxies). One
 * subscription per request — frames carry the constant id `sse` — served as `text/event-stream`
 * by the gateway edge (each `ServerFrame` JSON on a `data:` line). Subscribe-time failures
 * (non-watchable fn 404, bad `args` JSON / invalid filter 400, failed access guard 403) map to
 * the HTTP status BEFORE the stream starts; once streaming, a failure before the first frame ends
 * the stream with an `error` frame and a broken LIVE watch ends it with `reset` — resubscribe
 * without `since`. A client disconnect halts the response pump, tearing the db watch down.
 */
export const createRealtimeSseAction = (source: Wizard.WatchSource): Action<AnyType, AnyType> =>
  defineAction(
    {
      input: sseQuery,
      output: stream(),
      kind: 'stream',
      route: { method: 'GET', path: '/_realtime/sse', sse: true },
      onDisconnect: 'cancel',
      errors: {
        [WizardErrors.NotWatchable]: 404,
        [WizardErrors.BadFrame]: 400,
        [WizardErrors.BadFilter]: 400,
        [DbErrors.Validation]: 400,
      },
      description:
        'Realtime watch over Server-Sent Events. Query envelope: `fn` (a watchable query of this ' +
        'resource), optional `args` (JSON-encoded watch args, e.g. {"filter":...}) and optional ' +
        '`since` (the last observed version — suppresses the duplicate initial sync). Each SSE ' +
        '`data:` line is one ServerFrame: `sync`/`delta` while healthy, a terminal `error` frame ' +
        'if the watch breaks before going live, a terminal `reset` frame when a live watch breaks ' +
        '(resubscribe without `since`).',
      docs: { tags: ['realtime'] },
    },
    function* (params) {
      const request = yield* useRequest()
      const args = yield* parseSseArgs(params.args)
      const since = params.since === undefined ? undefined : Number(params.since)

      return (yield* openWatch({
        source,
        id: SSE_WATCH_ID,
        fn: params.fn,
        args,
        since,
        meta: request.meta,
      })) as never
    },
  ) as Action<AnyType, AnyType>
