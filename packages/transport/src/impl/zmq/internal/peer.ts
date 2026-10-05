import type { Operation } from 'std:effect'
import { attempt, createGate, ensure, fork, race, scoped, sleep, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure, succeed } from 'std:result'

import type { TransportDef } from 'transport:core'
import { TransportErrors } from 'transport:core'

import type { Helpers } from '../types/helpers'
import type { Zmq } from '../types/zmq'

import { CMD, REDIAL_MAX_MS, REDIAL_MIN_MS } from './const'
import { str, text } from './zmtp'

/**
 * The install's end of the hub protocol over whatever `dial` opens: one supervisor task dials,
 * reads the link until it closes — `OK` / `ERR` answer the pending `call`s by id, `MSG`s go to
 * the subscription they name — and, when `redial` is set, dials again with doubling backoff
 * (zmq semantics: a hub may come back) and re-announces every live subscription. Pending calls
 * of a lost connection fail `transport.connection`; a `call` made while down waits for the next
 * connection. The first dial may fail for `firstTimeoutMs` before this fails the install.
 * `onStatus` hears every transition AFTER the first connection.
 */
export function* createPeer(
  dial: () => Operation<Helpers.Link>,
  options: {
    readonly redial: boolean
    readonly firstTimeoutMs: number
    /** how long a call made while down waits for the hub before failing `transport.connection` */
    readonly offlineMs: number
    readonly onStatus: (status: TransportDef.Status) => void
  },
): Operation<Zmq.Peer> {
  const subscriptions = new Map<string, Helpers.Subscription>()
  const pending = new Map<string, Helpers.Pending>()
  const connected = createGate('zmq peer connected')
  const first = withResolvers<Result.Failure<unknown> | null>('zmq first dial')
  let live: Helpers.Link | null = null
  /** `live` once it is ready for calls (a regained hub has been told the subscriptions) */
  let open: Helpers.Link | null = null
  let closed = false
  /** the connection was lost and not yet regained (one status line per outage) */
  let down = false
  let nextId = 0

  const lost = (message: string): void => {
    for (const waiting of pending.values()) {
      waiting.reject(TransportErrors.Connection, message)
    }

    pending.clear()
  }

  const route = (frames: Uint8Array[]): void => {
    const [cmd, id, ...rest] = frames
    const key = str(id)

    switch (str(cmd)) {
      case CMD.ok: {
        pending.get(key)?.resolve(rest)
        pending.delete(key)

        break
      }
      case CMD.err: {
        pending.get(key)?.reject(str(rest[0]), str(rest[1]))
        pending.delete(key)

        break
      }
      case CMD.msg: {
        subscriptions.get(key)?.queue.add(rest)

        break
      }
      default: {
        break
      }
    }
  }

  /** One request/answer exchange over `link`, correlated by a fresh id. */
  const exchange = function* (link: Helpers.Link, frames: readonly Uint8Array[]) {
    const id = String(nextId++)
    const answer = withResolvers<Result<Uint8Array[]>>('zmq call')

    return yield* scoped(function* () {
      pending.set(id, {
        resolve: value => answer.resolve(succeed(value)),
        reject: (tag, message) => answer.resolve(fail(tag, message)),
      })
      yield* ensure(() => {
        pending.delete(id)
      })
      yield* link.send([frames[0] ?? text(''), text(id), ...frames.slice(1)])

      const result = yield* answer.operation

      return isFailure(result) ? yield* fail(result.error, result.message) : result.value
    })
  }

  const peer: Zmq.Peer = {
    subscriptions,

    *call(frames) {
      // a call made while down waits for the next connection — re-announced and ready — but
      // not past `offlineMs`
      const deadline = Date.now() + options.offlineMs

      for (;;) {
        if (closed) {
          return yield* fail(TransportErrors.Closed, 'zmq connection drained')
        }

        if (open !== null) {
          return yield* exchange(open, frames)
        }

        const left = deadline - Date.now()

        if (left <= 0) {
          return yield* fail(
            TransportErrors.Connection,
            `zmq hub unreachable for ${options.offlineMs}ms`,
          )
        }

        yield* race([connected.wait(), sleep(left)])
      }
    },

    *cast(frames) {
      if (live !== null) {
        yield* attempt(() => live!.send(frames))
      }
    },

    *close() {
      if (closed) {
        return
      }

      closed = true
      connected.notify()
      lost('zmq connection drained')

      const link = live

      if (link !== null) {
        yield* attempt(() => link.send([text(CMD.bye)]))
        yield* link.close()
      }

      for (const subscription of subscriptions.values()) {
        subscription.queue.close(undefined)
      }
    },
  }

  /** One connection generation: dial, announce, read until the link closes. Its link (and
   * socket) go with this scope. */
  const generation = function* () {
    const link = yield* dial()

    live = link

    // the reader runs first: the hub's answers to the re-announcements below come through it
    const reader = yield* fork(function* () {
      for (;;) {
        const step = yield* link.messages.next()

        if (step.done) {
          return
        }

        route(step.value)
      }
    })

    if (down) {
      down = false
      options.onStatus('connected')

      // a regained hub knows nothing of this install: every subscription is announced again
      // BEFORE any waiting call goes out, so what was published while down lands on them
      for (const subscription of subscriptions.values()) {
        yield* attempt(() => exchange(link, subscription.announce))
      }
    }

    open = link
    first.resolve(null)
    connected.notify()
    yield* reader
  }

  yield* fork(function* () {
    const startedAt = Date.now()
    let pause = REDIAL_MIN_MS
    let ever = false
    let lastFailure: Result.Failure<unknown> | null = null

    for (;;) {
      const outcome = yield* attempt(() => scoped(generation))

      ever ||= live !== null
      live = null
      open = null
      lost('hub connection lost')

      if (isFailure(outcome)) {
        lastFailure = outcome
      } else {
        pause = REDIAL_MIN_MS
      }

      if (closed) {
        return
      }

      if (!ever) {
        if (Date.now() - startedAt >= options.firstTimeoutMs) {
          first.resolve(lastFailure)

          return
        }
      } else if (options.redial) {
        if (!down) {
          down = true
          options.onStatus('reconnecting')
        }
      } else {
        options.onStatus('closed')

        return
      }

      yield* sleep(pause)
      pause = Math.min(pause * 2, REDIAL_MAX_MS)
    }
  })

  // the first connection, or why there is none
  const failure = yield* first.operation

  if (failure !== null) {
    closed = true

    return yield* fail(TransportErrors.Connection, 'cannot connect to the zmq hub', failure)
  }

  yield* ensure(() => peer.close())

  return peer
}
