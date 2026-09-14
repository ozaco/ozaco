import { operation } from 'std:effect'
import type { WsDef } from 'std:ws'
import { Ws, WsCauses } from 'std:ws'

import type { WebSocketHandler } from 'bun'

import { createConnection } from '../../src/ws/internal/connection'

/**
 * An ephemeral Bun server that upgrades EVERY request into the given websocket handler.
 * Pass a `port` only when a test must restart a server on the same address.
 */
const wsServer = (websocket: WebSocketHandler<undefined>, port = 0) =>
  Bun.serve({
    port,
    fetch(request, srv) {
      if (srv.upgrade(request)) {
        return
      }
      return new Response('no', { status: 400 })
    },
    websocket,
  })

/** Echoes every frame back to the sender. */
const echoServer = (port = 0) =>
  wsServer(
    {
      message(socket, data) {
        socket.send(data)
      },
    },
    port,
  )

/** Pushes the given frames as soon as the socket opens, then idles (no echo). */
const pushServer = (...frames: (string | Uint8Array)[]) =>
  wsServer({
    open(socket) {
      for (const frame of frames) {
        socket.send(frame)
      }
    },
    message() {},
  })

/**
 * A mock implementation of the `Ws` protocol: the real connection machinery (dial, reconnect,
 * keepalive, framing) driven by the given socket constructor instead of the platform `WebSocket`.
 * `yield* wsMock(FakeSocket).use(defaults?)` in place of `WsClient.use(defaults?)`.
 */
const wsMock = (socket: WsDef.ImplLike) => {
  const impl = Ws.implement<WsDef.Context, [defaults?: WsDef.Options]>({
    name: 'std/ws-mock',
    version: '0.0.0',

    *setup(defaults) {
      return { defaults: defaults ?? {} }
    },
  })

  return impl.build({
    connect: operation(function* (url: string | URL, options?: WsDef.Options) {
      const { defaults } = yield* impl.context.expect()

      return yield* createConnection(socket, url, { ...defaults, ...options })
    }, WsCauses.Connect),
  })
}

export { echoServer, pushServer, wsMock, wsServer }
