import type { Operation } from 'std:effect'
import { attempt, createQueue, ensure, fork, race, sleep, withResolvers } from 'std:effect'
import type { IODef } from 'std:io'
import { fail, isFailure } from 'std:result'

import { logTransport, TransportErrors } from 'transport:core'

import type { Helpers } from '../types/helpers'
import type { Zmq } from '../types/zmq'

import {
  DEALER_PEERS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
  HANDSHAKE_TIMEOUT_MS,
  ROUTER_PEERS,
} from './const'
import {
  createDecoder,
  encodeMessage,
  encodePing,
  encodePong,
  encodeReady,
  greeting,
  parseReady,
} from './zmtp'

/** The install option as the link runs it. */
export const heartbeatOf = (
  given: Zmq.Heartbeat | false | undefined,
): Helpers.HeartbeatSettings => {
  if (given === false) {
    return null
  }

  const intervalMs = given?.intervalMs ?? DEFAULT_HEARTBEAT_MS

  return {
    intervalMs,
    timeoutMs: Math.max(intervalMs, given?.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS),
  }
}

/**
 * A ZMTP link over a byte socket: greet, exchange `READY` (NULL mechanism, `Socket-Type`
 * checked for compatibility), then messages both ways; the peer's `PING`s are answered, its
 * other commands ignored. With a `heartbeat`, this side pings every `intervalMs` and closes the
 * connection when the peer sent nothing for `timeoutMs` (a dead peer behind a half-open socket).
 * Resolves once the handshake is done — or fails `transport.connection` when the peer is not a
 * zmq peer we can talk to, or stays silent past the handshake timeout. Binds to the calling
 * scope: the socket closes with it.
 */
export function* zmtpLink(
  socket: IODef.TcpSocket,
  socketType: Helpers.SocketType,
  heartbeat: Helpers.HeartbeatSettings = null,
): Operation<Helpers.Link> {
  const messages = createQueue<Uint8Array[], void>()
  const ready = withResolvers<string | null>('zmtp handshake')
  const accepts = socketType === 'ROUTER' ? ROUTER_PEERS : DEALER_PEERS
  const decoder = createDecoder()
  let closed = false
  let lastSeen = Date.now()

  const close = function* () {
    if (!closed) {
      closed = true
      messages.close(undefined)
      yield* socket.close()
    }
  }

  yield* socket.write(greeting())

  // the reader lives as long as the link's scope: bytes → events → the queue
  yield* fork(function* () {
    const inbound = yield* socket.data

    for (;;) {
      const step = yield* inbound.next()

      if (step.done) {
        ready.resolve('the peer closed the connection')
        yield* close()

        return
      }

      lastSeen = Date.now()

      for (const event of decoder.feed(step.value)) {
        switch (event.t) {
          case 'greeting': {
            yield* socket.write(encodeReady({ 'Socket-Type': socketType }))

            break
          }
          case 'command': {
            if (event.name === 'READY') {
              const peerType = parseReady(event.data)['Socket-Type'] ?? ''

              ready.resolve(
                accepts.has(peerType)
                  ? null
                  : `a ${peerType || 'typeless'} socket cannot talk to a ${socketType}`,
              )
            } else if (event.name === 'PING') {
              yield* attempt(() => socket.write(encodePong(event.data)))
            }

            break
          }
          case 'message': {
            messages.add(event.frames)

            break
          }
          case 'error': {
            ready.resolve(event.reason)
            yield* close()

            return
          }
          default: {
            break
          }
        }
      }
    }
  })

  const outcome = yield* race([
    ready.operation,
    (function* () {
      yield* sleep(HANDSHAKE_TIMEOUT_MS)

      return 'no ZMTP handshake within the timeout'
    })(),
  ])

  if (outcome !== null) {
    yield* close()

    return yield* fail(TransportErrors.Connection, `zmtp handshake failed: ${outcome}`)
  }

  yield* ensure(() => close())

  if (heartbeat !== null) {
    // liveness: a PING per interval; a peer silent for the whole timeout is gone
    yield* fork(function* () {
      for (;;) {
        yield* sleep(heartbeat.intervalMs)

        if (closed) {
          return
        }

        if (Date.now() - lastSeen > heartbeat.timeoutMs) {
          yield* logTransport('warn', 'transport zmq peer silent, closing', {
            'messaging.system': 'zmq',
            'network.peer.address': socket.remoteAddress,
            'ozaco.heartbeat.timeout_ms': heartbeat.timeoutMs,
          })
          yield* close()

          return
        }

        yield* attempt(() => socket.write(encodePing(heartbeat.timeoutMs)))
      }
    })
  }

  return {
    *send(frames) {
      if (closed) {
        return yield* fail(TransportErrors.Connection, 'zmtp link closed')
      }

      const written = yield* attempt(() => socket.write(encodeMessage(frames)))

      if (isFailure(written)) {
        // the socket died under us: close here, so the reader's end is not the first to know
        yield* close()

        return yield* fail(TransportErrors.Connection, 'zmtp link lost', written)
      }
    },
    messages,
    close,
  }
}

/** Two links joined back to back — the in-process connection between a peer and a hub in the
 * same process (`inproc://`, and every hub's own install). */
export const pairLinks = (): [Helpers.Link, Helpers.Link] => {
  const toLeft = createQueue<Uint8Array[], void>()
  const toRight = createQueue<Uint8Array[], void>()
  let closed = false
  const close = function* () {
    if (!closed) {
      closed = true
      toLeft.close(undefined)
      toRight.close(undefined)
    }
  }
  const end = (outbound: typeof toLeft): Helpers.Link => ({
    *send(frames) {
      if (closed) {
        return yield* fail(TransportErrors.Connection, 'inproc link closed')
      }

      // a wire copies: no buffer is shared across the two ends
      outbound.add(frames.map(part => new Uint8Array(part)))
    },
    messages: outbound === toLeft ? toRight : toLeft,
    close,
  })

  return [end(toRight), end(toLeft)]
}
