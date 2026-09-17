import { Codec } from 'std:codec'
import type { Flow } from 'std:effect'
import { guard } from 'std:effect'
import type { AnyType } from 'std:shared'

import { WsCauses } from '../errors'
import type { Helpers } from '../types/helpers'
import type { WsDef } from '../types/ws'

import { CONNECTING, OPEN } from './const'

/** Whether a socket generation can still take a `close(code, reason)` call. The webrtc channel
 * has a predicate of the same name over STRING `readyState`s; this one reads the socket's numeric
 * states, so the two are deliberately not shared. */
const isLive = (socket: WsDef.SocketLike | undefined): socket is WsDef.SocketLike =>
  socket !== undefined && (socket.readyState === OPEN || socket.readyState === CONNECTING)

/**
 * The consumer-facing connection over a session. `messages` hands back a subscription whose
 * `next()` pulls a raw frame off the shared queue and codec-decodes it — buffered frames survive
 * until read; `send` parks through reconnect windows; `close` is the client-initiated permanent
 * end (also what the resource teardown calls).
 */
export const createHandle = (session: Helpers.Session): WsDef.Connection => {
  const { reconnect, options } = session

  const messages: Flow<unknown, WsDef.FlowClose> = {
    *[Symbol.iterator]() {
      return yield* Codec.actions.decodeFrames(session.frames, options.codec)
    },
  }

  return {
    url: String(session.url),
    messages,
    closed: session.closed.future,

    get native() {
      return session.socket as WsDef.SocketLike
    },
    get readyState() {
      return (session.socket as WsDef.SocketLike).readyState
    },
    get reconnects() {
      return session.reconnects
    },

    send: guard(function* (data: unknown) {
      const payload = yield* Codec.actions.encodeFrame(data, options.codec)

      while (true) {
        if (session.ended || session.closedByClient) {
          return // permanently closed → WHATWG silent discard
        }

        const socket = session.socket
        if (socket && socket.readyState === OPEN) {
          socket.send(payload as AnyType)
          return
        }

        if (!reconnect) {
          return // closing/closed with no reconnect → WHATWG silent discard
        }

        // reconnect window: park until the next reopen (or the permanent end), then re-check
        yield* session.state.wait()
      }
    }, WsCauses.Send),

    close: guard(function* (code, reason) {
      session.closedByClient = true

      if (!session.ended) {
        const socket = session.socket

        if (isLive(socket)) {
          socket.close(code, reason)
        } else {
          // no live socket (mid-reconnect window or already closed) — finalize right here
          session.settle(true, session.lastClose ?? { code: code ?? 1000, reason: reason ?? '' })
        }
      }

      yield* session.closed.future
    }, WsCauses.Close),
  }
}
