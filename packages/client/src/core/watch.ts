// oxlint-disable import/exports-last
import { attempt, box, fork, operation, sleep, withResolvers } from 'std:effect'
import { fail, isFailure, isSuccess } from 'std:result'
import type { Result } from 'std:result'
import { Ws } from 'std:ws'
import type { WsDef } from 'std:ws'

import { JsonCodec } from 'std:codec/impl/json'

import { ClientErrors } from './errors'
import { isRecord, nextWatchId, realtimePathOf, resolveToken, toWsUrl } from './internal'
import type {
  ClientState,
  FrameDirection,
  FrameTap,
  LinkStatus,
  RealtimeLink,
  RealtimeTarget,
  ResourceLink,
  WatchEntry,
  WatchHandle,
  WatchOptions,
  WatchRows,
  WatchStop,
} from './types'

/**
 * REALTIME SUBSCRIPTION ENGINE. One `Ws` connection per resource realtime path, opened lazily on
 * the CLIENT scope (captured at `createClient` time) and shared by every watch of that resource;
 * the last stopped watch halts the pump task, which closes the socket (a `Ws` connection is a
 * scope-bound resource). Auto-reconnect is enabled — the `messages` flow is ONE continuous flow
 * across socket generations, but the SERVER forgets subscriptions on every drop, so a monitor
 * fork polls `connection.reconnects` (the only reconnection signal `WsDef.Connection` exposes —
 * there is no reconnect event) and re-sends every active watch with `since=<last version>` when
 * the counter increases.
 */

const RECONNECT = { retries: 10, delayMs: 300, backoff: 2, maxDelayMs: 10_000 } as const
const MONITOR_INTERVAL_MS = 200

const keyOf = (row: unknown): string | null =>
  isRecord(row) && typeof row['_id'] === 'string' ? row['_id'] : null

/** Rows → insertion-ordered map. `_id`-keyed when EVERY row has one, synthetic keys otherwise. */
const keyRows = (rows: readonly unknown[]): { rows: Map<string, unknown>; keyed: boolean } => {
  const keyed = rows.every(row => keyOf(row) !== null)
  const map = new Map<string, unknown>()

  for (const [index, row] of rows.entries()) {
    map.set(keyed ? (keyOf(row) as string) : `#${index}`, row)
  }

  return { rows: map, keyed }
}

const emit = (entry: WatchEntry): void => {
  entry.onRows([...entry.rows.values()], entry.version)
}

/** Publish one frame (or engine note) to every observer of a link. Taps never break the pump. */
const note = (link: ResourceLink, dir: FrameDirection, text: string): void => {
  if (link.taps.size === 0) {
    return
  }

  const frame = { at: Date.now(), dir, text }

  for (const tap of link.taps) {
    try {
      tap(frame)
    } catch {
      // an observer that throws is the observer's problem, never the socket's
    }
  }
}

/**
 * Render an incoming message for the timeline. With a codec installed, `std:ws` hands frames over
 * ALREADY DECODED — the raw text is gone, so it is re-rendered here rather than logged as opaque.
 */
const frameText = operation(function* (value: unknown) {
  if (typeof value === 'string') {
    return value
  }

  const rendered = yield* attempt(() => JsonCodec.actions.stringify(value))

  return isSuccess(rendered) ? rendered.value : '[binary frame]'
})

const setStatus = (link: ResourceLink, status: LinkStatus): void => {
  link.status = status
  note(link, 'sys', status)
}

const watchFrame = operation(function* (entry: WatchEntry, since?: number) {
  return yield* JsonCodec.actions.stringify({
    event: 'watch',
    id: entry.id,
    fn: entry.fn,
    ...(entry.args === undefined ? {} : { args: entry.args }),
    ...(since === undefined ? {} : { since }),
  })
})

const sendWatch = operation(function* (link: ResourceLink, entry: WatchEntry) {
  if (link.send) {
    const frame = yield* watchFrame(entry, entry.version >= 0 ? entry.version : undefined)

    yield* link.send(frame)
    note(link, 'out', frame)
  }
})

/** Apply one decoded server frame to its watch entry (unknown ids are silently ignored). */
const applyFrame = operation(function* (link: ResourceLink, frame: Record<string, unknown>) {
  const entry = typeof frame['id'] === 'string' ? link.entries.get(frame['id']) : undefined

  if (!entry) {
    return
  }

  const type = frame['type']

  if (type === 'sync' && Array.isArray(frame['rows'])) {
    const next = keyRows(frame['rows'])

    entry.rows = next.rows
    entry.keyed = next.keyed
    entry.version = typeof frame['version'] === 'number' ? frame['version'] : entry.version
    emit(entry)

    return
  }

  if (type === 'delta') {
    const added = Array.isArray(frame['added']) ? frame['added'] : []
    const changed = Array.isArray(frame['changed']) ? frame['changed'] : []
    const removed = Array.isArray(frame['removed']) ? frame['removed'] : []

    for (const row of [...added, ...changed]) {
      const key = keyOf(row)

      if (key !== null && entry.keyed) {
        entry.rows.set(key, row)
      } else {
        // unkeyed rows cannot be diffed — append under a synthetic key (sync frames replace all)
        entry.rows.set(`#${entry.rows.size}`, row)
      }
    }

    for (const id of removed) {
      if (typeof id === 'string') {
        entry.rows.delete(id)
      }
    }

    entry.version = typeof frame['version'] === 'number' ? frame['version'] : entry.version
    emit(entry)

    return
  }

  if (type === 'reset') {
    // the server declared our `since` stale: resubscribe WITHOUT since, expect a fresh sync
    entry.version = -1

    yield* sendWatch(link, entry)

    return
  }

  if (type === 'error') {
    entry.onError?.(
      fail(
        typeof frame['error'] === 'string' ? frame['error'] : ClientErrors.Watch,
        typeof frame['message'] === 'string' ? frame['message'] : 'watch failed',
        ...(typeof frame['requestId'] === 'string' ? [`requestId:${frame['requestId']}`] : []),
      ) as Result.Failure<unknown>,
    )
  }
})

/**
 * Decode one incoming ws message: objects pass through (codec in scope), strings go through the
 * codec. Decoding is best-effort — a foreign or truncated frame is ignored, never fatal; a MISSING
 * `JsonCodec` install cannot hide here because `sendWatch` already raises on the first watch.
 */
const decodeMessage = operation(function* (value: unknown) {
  if (isRecord(value)) {
    return value
  }

  if (typeof value === 'string') {
    const parsed = yield* attempt(() => JsonCodec.actions.parse<unknown>(value))

    return isSuccess(parsed) && isRecord(parsed.value) ? parsed.value : null
  }

  return null
})

/** See the module doc — polls `reconnects` and re-sends active watches with `since` on a bump. */
const monitorReconnects = operation(function* (link: ResourceLink, connection: WsDef.Connection) {
  let seen = connection.reconnects

  for (;;) {
    yield* sleep(MONITOR_INTERVAL_MS)

    if (connection.reconnects === seen) {
      continue
    }

    seen = connection.reconnects
    setStatus(link, 'open')
    note(link, 'sys', `reconnected (#${seen}) — resending ${link.entries.size} watch(es)`)

    for (const entry of link.entries.values()) {
      yield* attempt(() => sendWatch(link, entry))
    }
  }
})

const notifyAll = (link: ResourceLink, failure: Result.Failure<unknown>) => {
  for (const entry of link.entries.values()) {
    entry.onError?.(failure)
  }
}

/**
 * The per-link pump (runs `box()`ed on the client scope): dial the shared connection, mark the
 * link ready, fork the reconnect monitor, then route every incoming frame. A permanent flow end
 * with a failure close (e.g. `ws/reconnect-exhausted`) notifies every active watch's `onError`.
 */
const linkPump = operation(function* (state: ClientState, link: ResourceLink) {
  const token = resolveToken(state)
  const query = token === undefined || token === '' ? '' : `?token=${encodeURIComponent(token)}`
  const url = `${toWsUrl(state.options.url)}${link.path}${query}`

  setStatus(link, 'connecting')

  const dialed = yield* attempt(() => Ws.actions.connect(url, { reconnect: RECONNECT }))

  if (isFailure(dialed)) {
    link.failure = dialed
    setStatus(link, 'closed')
    note(link, 'err', `connect failed: ${dialed.message}`)
    link.markReady()
    notifyAll(link, dialed)

    return
  }

  const connection = dialed.value

  link.send = text => connection.send(text)
  setStatus(link, 'open')
  link.markReady()

  yield* fork(() => monitorReconnects(link, connection))

  const messages = yield* connection.messages

  try {
    for (;;) {
      const step = yield* messages.next()

      if (step.done) {
        if (isFailure(step.value)) {
          link.failure = step.value
          note(link, 'err', `stream closed: ${step.value.message}`)
          notifyAll(link, step.value)
        }

        return
      }

      // rendering costs nothing when nobody is watching the timeline
      if (link.taps.size > 0) {
        note(link, 'in', yield* frameText(step.value))
      }

      const frame = yield* decodeMessage(step.value)

      if (frame) {
        yield* applyFrame(link, frame)
      }
    }
  } finally {
    setStatus(link, 'closed')
  }
})

/** Get or create the shared link for a realtime path — creation is synchronous (no yield before
 * the map insert), so concurrent watches of the same resource never race two pumps. */
const ensureLink = (state: ClientState, path: string): ResourceLink => {
  const existing = state.links.get(path)

  if (existing) {
    return existing
  }

  const gate = withResolvers<void>('client:link-ready')

  const link: ResourceLink = {
    path,
    entries: new Map(),
    task: undefined,
    send: undefined,
    ready: gate.operation,
    markReady: () => {
      gate.resolve()
    },
    failure: undefined,
    status: 'idle',
    pinned: false,
    taps: new Set<FrameTap>(),
  }

  state.links.set(path, link)

  return link
}

/** Start the link's pump if it is not already running (idempotent — one pump per link). */
const connectLink = (state: ClientState, link: ResourceLink): ResourceLink => {
  link.task ??= state.scope.run(() => box(() => linkPump(state, link)))

  return link
}

/** Ensure a connected link and wait for its dial to settle; a failed dial raises `client.watch`. */
const dial = operation(function* (state: ClientState, path: string) {
  const link = connectLink(state, ensureLink(state, path))

  yield* link.ready

  if (link.failure) {
    return yield* fail(
      ClientErrors.Watch,
      `realtime connection to "${path}" failed: ${link.failure.message}`,
      `ws:${String(link.failure.error)}`,
    )
  }

  return link
})

/** Send `unwatch` (best effort — a dead socket has already forgotten the subscription). */
const sendUnwatch = operation(function* (link: ResourceLink, id: string) {
  const send = link.send

  if (!send) {
    return
  }

  yield* attempt(function* () {
    const frame = yield* JsonCodec.actions.stringify({ event: 'unwatch', id })

    yield* send(frame)
    note(link, 'out', frame)
  })
})

/** Halt the pump and forget the link — the socket closes with its task. */
const closeLink = operation(function* (state: ClientState, link: ResourceLink) {
  state.links.delete(link.path)
  link.entries.clear()
  link.pinned = false

  const task = link.task

  link.task = undefined
  link.send = undefined

  if (task) {
    yield* attempt(() => task.halt())
  }

  setStatus(link, 'closed')
})

export interface WatchInput {
  readonly resource: string
  readonly fn: string
  readonly args: unknown
  readonly onRows: WatchRows
  readonly options?: WatchOptions | undefined
}

/** Register one watch on an already-dialed link and send its `watch` frame. */
const registerWatch = operation(function* (
  state: ClientState,
  link: ResourceLink,
  input: Omit<WatchInput, 'resource'>,
) {
  const entry: WatchEntry = {
    id: nextWatchId(),
    fn: input.fn,
    args: input.args,
    onRows: input.onRows,
    onError: input.options?.onError,
    rows: new Map(),
    keyed: false,
    version: -1,
  }

  link.entries.set(entry.id, entry)
  yield* sendWatch(link, entry)

  const handle: WatchHandle = {
    id: entry.id,
    rows: () => [...entry.rows.values()],
    version: () => entry.version,
    stop: operation(function* () {
      if (!link.entries.delete(entry.id)) {
        return
      }

      yield* sendUnwatch(link, entry.id)

      if (link.entries.size === 0 && !link.pinned) {
        yield* closeLink(state, link)
      }
    }),
  }

  return handle
})

/**
 * Raw realtime access for tooling: explicit lifecycle, a frame timeline and untyped `fn`-addressed
 * watches. Shares the very same link (and socket) the typed `.watch()` API uses.
 */
export const openRealtime = operation(function* (state: ClientState, target: RealtimeTarget) {
  if (target.path === undefined && target.resource === undefined) {
    return yield* fail(
      ClientErrors.Watch,
      'realtime needs either a `resource` or an explicit `path`',
    )
  }

  const path = target.path ?? realtimePathOf(state, target.resource as string)
  const link = connectLink(state, ensureLink(state, path))

  // the opener owns the socket now: stopping the last watch must not drop it
  link.pinned = true

  const handle: RealtimeLink = {
    path,
    status: () => link.status,
    tap: observer => {
      link.taps.add(observer)

      return () => {
        link.taps.delete(observer)
      }
    },
    watch: input =>
      operation(function* () {
        const dialed = yield* dial(state, path)

        return yield* registerWatch(state, dialed, {
          fn: input.fn,
          args: input.args,
          onRows: input.onRows,
          options: input.options,
        })
      })(),
    close: () => closeLink(state, link),
  }

  return handle
})

/** Start one watch: ensure the shared link, register the entry, send the `watch` frame. */
export const startWatch = operation(function* (state: ClientState, input: WatchInput) {
  const path = realtimePathOf(state, input.resource)
  const link = yield* dial(state, path)
  const handle = yield* registerWatch(state, link, input)
  const stop: WatchStop = handle.stop

  return stop
})
