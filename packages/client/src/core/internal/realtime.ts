import type { Flow, Operation, Subscription } from 'std:effect'
import { attempt, createQueue, fork, sleep } from 'std:effect'
import { IO } from 'std:io'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { Ws } from 'std:ws'

import { DEFAULT_REALTIME_SUFFIX } from '../const'
import { ClientErrors } from '../errors'
import type { ClientDef } from '../types/client'

const RECONNECT_POLL_MS = 100

const socketUrl = (ctx: ClientDef.Context, resource: string): string => {
  const url = new URL(
    `/${resource}${ctx.options.realtimePath ?? DEFAULT_REALTIME_SUFFIX}`,
    ctx.options.url,
  )
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const token = typeof ctx.options.token === 'function' ? ctx.options.token() : ctx.options.token

  if (token) {
    url.searchParams.set('token', token)
  }

  return url.toString()
}

type Frame =
  | ClientDef.WatchFrame
  | { readonly t: 'error'; readonly tag: string; readonly message: string }

/**
 * A resource watch as a Flow of `sync` / `delta` frames over the realtime socket. The socket
 * reconnects by itself; after every reopen the watch is re-sent with `since: <last token>` so the
 * consumer sees one continuous sequence. `error` frames close the flow with that failure.
 */
export const watch = <TRow>(
  ctx: ClientDef.Context,
  resource: string,
  options: ClientDef.WatchOptions | undefined,
): Flow<ClientDef.WatchFrame<TRow>, void> => ({
  *[Symbol.iterator]() {
    const id = yield* IO.actions.uuid()
    const token = typeof ctx.options.token === 'function' ? ctx.options.token() : ctx.options.token
    const connection = yield* Ws.actions.connect(socketUrl(ctx, resource), {
      headers: {
        ...ctx.options.headers,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      reconnect: { retries: 10, delayMs: 100, backoff: 2, maxDelayMs: 5000 },
    })
    let since = options?.since
    const subscribe = (): Operation<void> =>
      connection.send({
        t: 'watch',
        id,
        filter: options?.filter,
        order: options?.order,
        since,
      })
    yield* subscribe()

    const frames = createQueue<Frame, AnyType>()
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
        return { done: false, value: frame as ClientDef.WatchFrame<TRow> }
      },
    }
    return subscription
  },
})

/** `watch` folded into the current rows (`_id`-keyed) plus the last token. */
export const rows = <TRow>(
  ctx: ClientDef.Context,
  resource: string,
  options: ClientDef.WatchOptions | undefined,
): Flow<ClientDef.Materialized<TRow>, void> => ({
  *[Symbol.iterator]() {
    const source = yield* watch<TRow>(ctx, resource, options)
    const byId = new Map<string, TRow>()
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
        } else {
          for (const row of [...frame.added, ...frame.changed]) {
            byId.set(String((row as AnyType)._id), row)
          }
          for (const id of frame.removed) {
            byId.delete(id)
          }
        }
        return { done: false, value: { rows: [...byId.values()], token: frame.token } }
      },
    }
    return subscription
  },
})
