import type { Flow, Operation, Subscription } from 'std:effect'
import { attempt, createQueue, fork, sleep } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { Ws } from 'std:ws'

import { DEFAULT_REALTIME_SUFFIX } from '../const'
import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'
import type { Helpers } from '../types/helpers'

import { manifestOf } from './manifest'

const RECONNECT_POLL_MS = 100

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
    const socket = (manifest.value.sockets ?? []).find(
      entry => entry.service === resource && entry.protocol === 'resource',
    )

    if (socket) {
      return socket.path
    }
  }

  return `/${resource}${DEFAULT_REALTIME_SUFFIX}`
}

const socketUrl = (ctx: ClientDef.Context, path: string): string => {
  const url = new URL(path, ctx.options.url)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const token = typeof ctx.options.token === 'function' ? ctx.options.token() : ctx.options.token

  if (token) {
    url.searchParams.set('token', token)
  }

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
    const subscribe = (): Operation<void> =>
      connection.send({
        t: 'watch',
        id,
        filter: options?.filter,
        order: options?.order,
        ...(options?.limit === undefined ? {} : { limit: options.limit, cursor, back }),
        since,
      })
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

    const frames = createQueue<Helpers.Frame, AnyType>()
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
