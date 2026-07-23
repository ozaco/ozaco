import type { Future, Stream } from 'std:effect'
import { createQueue, operation, withResolvers } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'

import { wsImpl } from '../context'
import { decodeFrame, encodeFrame } from '../internal/frame'
import type { WsDef } from '../types'

const OPEN = 1

/**
 * Open a WebSocket. The returned `Future<Connection>` resolves once the socket is OPEN (or fails with
 * `'ws/connect'` if it errors during the handshake). Outgoing/incoming frames are (de)serialized
 * through the registered `std:codec` — so a codec (e.g. `JsonCodec`) must be installed in scope.
 * Incoming frames are exposed as `messages` — a queue-backed effect Stream (buffered until consumed,
 * decoded on pull) that closes `true` on a clean close or with a failure on error. Consume it with a
 * `next()` loop or `streamForEach`; read `closed` for the exit.
 */
export const connect = operation(function* (url: string | URL, options?: WsDef.Options) {
  const Ctor = yield* wsImpl.get()
  if (!Ctor) {
    return yield* fail('ws/unsupported', 'no WebSocket implementation available (set wsImpl)')
  }

  // headers require the Bun/Node options-object constructor form; without them, use the standard
  // `protocols` second arg so the browser WebSocket stays happy.
  let socket: WsDef.SocketLike
  if (options?.headers) {
    socket = new Ctor(url, {
      headers: options.headers,
      ...(options.protocols ? { protocols: options.protocols } : {}),
    })
  } else if (options?.protocols) {
    socket = new Ctor(url, options.protocols)
  } else {
    socket = new Ctor(url)
  }

  // receive binary frames as ArrayBuffer, not the default Blob — consistent across Bun/Node/browser
  // and passed straight through by `decodeFrame`.
  socket.binaryType = 'arraybuffer'

  // the queue holds RAW frames; decoding happens lazily on pull (see `decoded.next`), which lets the
  // codec run inside the effectful `next()` instead of the synchronous onmessage callback.
  const queue = createQueue<unknown, WsDef.StreamClose>()
  const opened = withResolvers<void>('ws:open')
  const closedResolvers = withResolvers<WsDef.CloseInfo>('ws:closed')

  // on* assignment (not addEventListener): SocketLike is the handler-property shape shared by the
  // browser WebSocket, Bun, and node's global WebSocket.
  /* oxlint-disable unicorn/prefer-add-event-listener */
  socket.onopen = () => opened.resolve()
  socket.onmessage = event => queue.add(event.data)
  socket.onerror = () => {
    const failure = fail('ws/connect', `websocket error: ${String(url)}`) as Result.Failure<unknown>
    opened.reject(failure) // no-op once already open
    queue.close(failure)
  }
  socket.onclose = event => {
    queue.close(true)
    closedResolvers.resolve({ code: event?.code ?? 1000, reason: event?.reason ?? '' })
  }
  /* oxlint-enable unicorn/prefer-add-event-listener */

  // block until OPEN (or fail fast if the handshake errored)
  yield* opened.operation

  const closed = operation(function* () {
    return yield* closedResolvers.operation
  })() as Future<WsDef.CloseInfo>

  // a Stream is `Operation<Subscription>`; this hands back a subscription whose `next()` pulls a raw
  // frame off the queue and codec-decodes it — buffered frames survive until a consumer reads them.
  const decoded = {
    next: operation(function* () {
      const item = yield* queue.next()
      if (item.done) {
        return item
      }
      return { done: false, value: yield* decodeFrame(item.value) }
    }),
  }
  const messages = {
    *[Symbol.iterator]() {
      return decoded
    },
  } as Stream<unknown, WsDef.StreamClose>

  const connection: WsDef.Connection = {
    native: socket,
    url: String(url),
    get readyState() {
      return socket.readyState
    },
    send: operation(function* (data: unknown) {
      socket.send(yield* encodeFrame(data))
    }),
    messages,
    close: operation(function* (code, reason) {
      if (socket.readyState === OPEN) {
        socket.close(code, reason)
      }
      yield* closedResolvers.operation
    }),
    closed,
  }

  return connection
}, 'ws-connect')
