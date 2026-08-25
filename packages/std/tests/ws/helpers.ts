import type { WebSocketHandler } from 'bun'

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

export { echoServer, pushServer, wsServer }
