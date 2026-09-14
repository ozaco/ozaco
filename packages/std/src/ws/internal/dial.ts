import type { Helpers as EffectHelpers } from 'std:effect'
import { operation, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'

import { WsCauses, WsErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { WsDef } from '../types/ws'

import { CONNECTING, OPEN } from './const'

/**
 * Construct one socket. Headers require the Bun/Node options-object constructor form; without
 * them, the standard `protocols` second arg keeps the browser WebSocket happy. A browser cannot
 * set handshake headers at all (its constructor rejects the options form): they are dropped
 * there — carry a token as a `?token=` query param instead.
 */
const construct = (impl: WsDef.ImplLike, session: Helpers.Session): WsDef.SocketLike => {
  const { url, options } = session
  const inBrowser = typeof document !== 'undefined' && typeof window !== 'undefined'

  if (options.headers && !inBrowser) {
    return new impl(url, {
      headers: options.headers,
      ...(options.protocols ? { protocols: options.protocols } : {}),
    })
  }

  if (options.protocols) {
    return new impl(url, options.protocols)
  }

  return new impl(url)
}

// on* assignment (not addEventListener): SocketLike is the handler-property shape shared by the
// browser WebSocket, Bun, and node's global WebSocket.
/* oxlint-disable unicorn/prefer-add-event-listener */

const unwire = (socket: WsDef.SocketLike) => {
  socket.onopen = null
  socket.onmessage = null
  socket.onerror = null
  socket.onclose = null
}

/** Hook one generation into the session: adoption on open, frames into the shared queue,
 * errors/closes routed to `settle` or the reconnect supervisor. */
const wire = (
  session: Helpers.Session,
  socket: WsDef.SocketLike,
  opened: EffectHelpers.WithResolvers<void>,
) => {
  const { url, reconnect } = session

  socket.onopen = () => {
    if (session.ended || session.closedByClient) {
      // the connection ended while this dial was in flight — do not adopt, just dispose
      socket.close()
      opened.reject(fail(WsErrors.Connect, `connection closed during dial: ${String(url)}`))
      return
    }

    session.socket = socket
    opened.resolve()
    session.notifyState()
  }

  socket.onmessage = event => {
    // every generation feeds the SAME queue — `messages` is one continuous flow
    if (!session.ended) {
      session.frames.add(event.data)
    }
  }

  socket.onerror = () => {
    const failure = fail(
      WsErrors.Connect,
      `websocket error: ${String(url)}`,
    ) as Result.Failure<unknown>
    opened.reject(failure) // no-op once already open

    if (!session.ended && session.socket === socket && !reconnect) {
      // post-open error on a single-shot connection: the flow closes with this at onclose
      session.erred = failure
    }
  }

  socket.onclose = event => {
    if (session.ended || session.socket !== socket) {
      return // a superseded or never-adopted generation — nothing to do
    }

    const info = { code: event?.code ?? 1000, reason: event?.reason ?? '' }
    session.lastClose = info

    if (session.closedByClient) {
      session.settle(true, info) // clean client close → the flow ends `true`
      return
    }

    if (!reconnect) {
      session.settle(session.erred ?? true, info) // single-shot: any server-side end is permanent
      return
    }

    session.notifyState()
    session.outages.add(info) // hand the outage to the reconnect supervisor
  }
}

/* oxlint-enable unicorn/prefer-add-event-listener */

/**
 * Dial ONE socket generation: construct, wire, resolve once OPEN (adopting the socket as
 * current) or raise `WsErrors.Connect`. On failure — or a halt mid-handshake — the socket is unhooked
 * and disposed so nothing leaks.
 */
export const dial = operation(function* (session: Helpers.Session, impl: WsDef.ImplLike) {
  const socket = construct(impl, session)

  // receive binary frames as ArrayBuffer, not the default Blob — consistent across
  // Bun/Node/browser and passed straight through by `decodeFrame`.
  socket.binaryType = 'arraybuffer'

  const opened = withResolvers<void>('ws:open')
  wire(session, socket, opened)

  let adopted = false
  try {
    yield* opened.operation
    adopted = true
  } finally {
    if (!adopted) {
      // handshake failed OR we were halted mid-dial: unhook and dispose the socket
      unwire(socket)

      if (socket.readyState === CONNECTING || socket.readyState === OPEN) {
        socket.close()
      }
    }
  }
}, WsCauses.Dial)
