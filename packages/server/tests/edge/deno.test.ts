import type { AnyType } from 'std:shared'

import { DenoEdge, denoImpl } from 'server:impl/edge/deno'

import { runEdgeSuite } from '../suites/edge'

/**
 * A fake Deno runtime over `Bun.serve`: the driver's contract (serve + upgradeWebSocket) is all
 * the suite exercises, so the deno edge is proven under bun without a Deno install.
 */
const fakeDeno = {
  serve(options: AnyType, handler: (request: Request) => Response | Promise<Response>) {
    const pending = new Map<Request, AnyType>()
    const server = Bun.serve<{ socket: AnyType }>({
      port: options.port ?? 0,
      hostname: options.hostname ?? '127.0.0.1',
      async fetch(request, bunServer) {
        const response = await handler(request)
        const upgrade = pending.get(request)
        if (upgrade) {
          pending.delete(request)
          return bunServer.upgrade(request, { data: { socket: upgrade } })
            ? (undefined as AnyType)
            : new Response('upgrade failed', { status: 500 })
        }
        return response
      },
      websocket: {
        open(ws) {
          ws.data.socket.open(ws)
        },
        message(ws, message) {
          ws.data.socket.message(typeof message === 'string' ? message : new Uint8Array(message))
        },
        close(ws, code, reason) {
          ws.data.socket.close(code, reason)
        },
      },
    })
    options.onListen?.({ port: server.port, hostname: String(server.hostname) })
    return {
      addr: { port: server.port, hostname: String(server.hostname) },
      shutdown: () => Promise.resolve(server.stop(true)),
      // the fake's upgrade registers a pending socket for the fetch above
      pending,
    }
  },
  upgradeWebSocket(request: Request) {
    // a fake web WebSocket: events are dispatched by the bun websocket handlers above
    const target = new EventTarget()
    let ws: AnyType = null
    const socket = Object.assign(target, {
      send: (payload: string | Uint8Array) => ws?.send(payload),
      close: (code?: number, reason?: string) => ws?.close(code, reason),
    })
    const bridge = {
      open(bunSocket: AnyType) {
        ws = bunSocket
        target.dispatchEvent(new Event('open'))
      },
      message(data: string | Uint8Array) {
        target.dispatchEvent(new MessageEvent('message', { data }))
      },
      close(code: number, reason: string) {
        target.dispatchEvent(new CloseEvent('close', { code, reason }))
      },
    }
    fakeDeno.last?.pending.set(request, bridge)
    return { socket: socket as unknown as WebSocket, response: new Response(null, { status: 101 }) }
  },
  last: null as AnyType,
}
const serveOriginal = fakeDeno.serve
fakeDeno.serve = (options, handler) => {
  const server = serveOriginal(options, handler)
  fakeDeno.last = server
  return server
}

runEdgeSuite({
  label: 'deno',
  enabled: true,
  edge: DenoEdge.use(),
  listens: true,
  *install() {
    yield* denoImpl.set(fakeDeno as AnyType)
  },
})
