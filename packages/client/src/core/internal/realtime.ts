import type { Flow, Operation, Subscription } from 'std:effect'
import { attempt, createQueue, fork, sleep, withResolvers } from 'std:effect'
import { IO } from 'std:io'
import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import type { WsDef } from 'std:ws'
import { Ws } from 'std:ws'

import { DEFAULT_REALTIME_SUFFIX } from '../const'
import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'
import type { Helpers } from '../types/helpers'

import { manifestOf } from './manifest'

const RECONNECT_POLL_MS = 100

/** The close code the edge REFUSES a socket with: the handshake was rejected (a missing,
 * expired or malformed token). It is a verdict, not an outage — every other application code
 * (4000–4999 is WHATWG's private range) stays a plain drop and reconnects as usual. */
const REFUSED_CODE = 4401

/** Where a resource's realtime socket lives: an explicit watch `path` wins, then an
 * EXPLICITLY configured `realtimePath` option (the user knows their topology — a rewriting
 * proxy must not lose to discovery), then the MANIFEST's socket entry for the service
 * (`protocol: 'resource'` — custom mounts found for free), then the conventional
 * `/<resource>/_realtime` suffix. */
function* socketPath(
  ctx: ClientDef.Context,
  resource: string,
  override: string | undefined,
): Operation<string> {
  if (override) {
    return override
  }

  if (ctx.options.realtimePath !== undefined) {
    return `/${resource}${ctx.options.realtimePath}`
  }

  const manifest = yield* attempt(() => manifestOf(ctx))

  if (!isFailure(manifest)) {
    const socket = manifest.value.services
      .find(entry => entry.name === resource)
      ?.actions.find(entry => entry.kind === 'socket' && entry.protocol === 'resource')

    if (socket && socket.kind === 'socket') {
      return socket.path
    }
  }

  return `/${resource}${DEFAULT_REALTIME_SUFFIX}`
}

const socketUrl = (ctx: ClientDef.Context, path: string): string => {
  const url = new URL(path, ctx.options.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'

  // tokens never ride the URL: browsers authorize with a first `{ t: 'auth' }` frame,
  // everything else with the authorization header
  return url.toString()
}

/**
 * A resource watch as a Flow of `sync` / `delta` frames over the realtime socket. The socket
 * reconnects by itself; after every reopen the watch is re-sent with `since: <last token>` so the
 * consumer sees one continuous sequence. `error` frames close the flow with that failure.
 */
// oxlint-disable-next-line max-params -- ctx · resource · options · pager hooks
export const watch = <TRow>(
  ctx: ClientDef.Context,
  resource: string,
  options: ClientDef.WatchOptions | undefined,
  hooks?: Helpers.WatchHooks,
): Flow<ClientDef.WatchFrame<TRow>, void> => ({
  *[Symbol.iterator]() {
    const id = yield* IO.actions.uuid()
    const path = yield* socketPath(ctx, resource, options?.path)
    const token = typeof ctx.options.token === 'function' ? ctx.options.token() : ctx.options.token
    const connection = yield* Ws.actions.connect(socketUrl(ctx, path), {
      headers: {
        ...ctx.options.headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      reconnect: { retries: 10, delayMs: 100, backoff: 2, maxDelayMs: 5000 },
    })
    let since = options?.since
    let cursor = options?.cursor
    let back = options?.back === true
    const frames = createQueue<Helpers.Frame, AnyType>()

    // --- refusals ---------------------------------------------------------------------------
    // the socket reconnects by itself, and its retry budget resets on every successful reopen —
    // but a REFUSED session reopens successfully every time (auth is settled after the upgrade,
    // in-band) only to be closed again, so redialing it is an endless loop with the caller
    // parked on `next()` forever. The live socket's close code ends the watch instead.
    let refused: Result.Failure<unknown> | null = null
    const refusal = withResolvers<void>('watch:refused')
    const guarded = new WeakSet<object>()

    /** Chain a refusal check onto the CURRENT socket generation (`native` is the documented
     * escape hatch; the connection's own handler stays in place and runs first). Called from
     * `subscribe`, so every generation is guarded before this watch says anything on it. */
    const guardRefusal = () => {
      const native: WsDef.SocketLike | undefined = connection.native

      if (!native || guarded.has(native)) {
        return
      }

      guarded.add(native)
      const previous = native.onclose

      // SocketLike is the handler-property shape shared by browser/Bun/Node — this one
      // CHAINS onto `previous` instead of replacing it
      // oxlint-disable-next-line unicorn/prefer-add-event-listener
      native.onclose = event => {
        previous?.(event)
        const code = event?.code ?? 0

        if (refused !== null || code !== REFUSED_CODE) {
          return
        }

        refused = fail(
          ClientErrors.Refused,
          `realtime socket refused: ${code}${event?.reason ? ` ${event.reason}` : ''}`,
          `ws:${code}`,
        ) as Result.Failure<unknown>
        frames.close(refused as AnyType)
        refusal.resolve()
      }
    }

    const subscribe = function* (): Operation<void> {
      guardRefusal()

      // in-band auth FIRST on every (re)connect — the server settles it before the watch
      const bearer =
        typeof ctx.options.token === 'function' ? ctx.options.token() : ctx.options.token

      if (bearer) {
        yield* connection.send({ t: 'auth', token: bearer })
      }

      yield* connection.send({
        t: 'watch',
        id,
        filter: options?.filter,
        order: options?.order,
        ...(options?.limit === undefined ? {} : { limit: options.limit, cursor, back }),
        since,
      })
    }
    yield* subscribe()

    // page turns arrive from promise land: a fresh watch on the SAME id replaces the window
    if (hooks?.register) {
      const turns = createQueue<{ cursor: string | null; back: boolean }, void>()

      yield* fork(function* () {
        for (;;) {
          const step = yield* turns.next()

          if (step.done) {
            return
          }

          cursor = step.value.cursor ?? undefined
          back = step.value.back
          since = undefined
          yield* attempt(subscribe)
        }
      })

      hooks.register((next, backward) => turns.add({ cursor: next, back: backward === true }))
    }

    // pump: every frame of this watch into the queue
    yield* fork(function* () {
      const messages = yield* attempt(connection.messages)
      if (isFailure(messages)) {
        frames.close(messages)
        return
      }
      for (;;) {
        const step = yield* messages.value.next()
        if (step.done) {
          frames.close(step.value === true ? undefined : step.value)
          return
        }
        const frame = step.value as AnyType
        if (frame && frame.id === id) {
          frames.add(frame)
        }
      }
    })
    // a refusal is permanent: end the connection for good, or its supervisor would keep
    // redialing into the same verdict in the background for as long as the scope lives
    yield* fork(function* () {
      yield* refusal.operation
      yield* attempt(() => connection.close())
    })
    // re-subscribe after every reconnect, resuming from the last token
    yield* fork(function* () {
      let seen = connection.reconnects
      for (;;) {
        yield* sleep(RECONNECT_POLL_MS)
        if (connection.reconnects !== seen) {
          seen = connection.reconnects
          yield* attempt(subscribe)
        }
      }
    })

    const subscription: Subscription<ClientDef.WatchFrame<TRow>, void> = {
      *next() {
        const step = yield* frames.next()
        if (step.done) {
          // the server refused this session (4401 = the handshake was rejected): the verdict
          // itself is the answer — retrying with the same token would only loop
          if (refused !== null) {
            return yield* refused
          }
          if (step.value && isFailure(step.value)) {
            return yield* fail(
              ClientErrors.Closed,
              'realtime socket closed',
              String(step.value.error),
            )
          }
          return { done: true, value: undefined }
        }
        const frame = step.value
        if (frame.t === 'error') {
          return yield* fail(frame.tag, frame.message)
        }
        since = frame.token
        hooks?.onPage?.((frame as AnyType).page ?? null)
        return { done: false, value: frame as ClientDef.WatchFrame<TRow> }
      },
    }
    return subscription
  },
})

/** `watch` folded into the current rows (`_id`-keyed) plus the last token and pager info. */
// oxlint-disable-next-line max-params -- ctx · resource · options · pager hooks
export const rows = <TRow>(
  ctx: ClientDef.Context,
  resource: string,
  options: ClientDef.WatchOptions | undefined,
  hooks?: Helpers.WatchHooks,
): Flow<ClientDef.Materialized<TRow>, void> => ({
  *[Symbol.iterator]() {
    const source = yield* watch<TRow>(ctx, resource, options, hooks)
    const byId = new Map<string, TRow>()
    let page: ClientDef.WindowInfo | undefined
    const subscription: Subscription<ClientDef.Materialized<TRow>, void> = {
      *next() {
        const step = yield* source.next()
        if (step.done) {
          return step
        }
        const frame = step.value
        if (frame.t === 'sync') {
          byId.clear()
          for (const row of frame.rows) {
            byId.set(String((row as AnyType)._id), row)
          }
        } else if (frame.t === 'delta') {
          for (const row of [...frame.added, ...frame.changed]) {
            byId.set(String((row as AnyType)._id), row)
          }
          for (const id of frame.removed) {
            byId.delete(id)
          }
        }
        if ((frame as AnyType).page) {
          page = (frame as AnyType).page
        }
        return {
          done: false,
          value: { rows: [...byId.values()], token: frame.token, ...(page ? { page } : {}) },
        }
      },
    }
    return subscription
  },
})
