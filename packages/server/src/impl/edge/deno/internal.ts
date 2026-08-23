// oxlint-disable import/exports-last
import type { EdgeDef } from 'server:core'
import { createContext, until, useContext } from 'std:effect'

import type { DenoEdgeDef } from './types'

export const StateRef = createContext<DenoEdgeDef.State>('server:impl/edge/deno')

/** A web `WebSocket` (Deno's upgrade) as the engine's raw socket. */
const rawOf = (ws: WebSocket): EdgeDef.RawSocket => ({
  send: payload => {
    ws.send(payload)
  },
  close: (code, reason) => {
    ws.close(code, reason)
  },
  onMessage: listener => {
    ws.addEventListener('message', event => {
      const data = (event as MessageEvent).data
      listener(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer))
    })
  },
  onClose: listener => {
    ws.addEventListener('close', event => {
      listener((event as CloseEvent).code, (event as CloseEvent).reason)
    })
  },
})

export const driver: EdgeDef.Driver = {
  runtime: 'deno',

  *serve(options, handlers) {
    const state = yield* useContext(StateRef)
    const runtime = state.runtime as DenoEdgeDef.Runtime
    const hostname = options.hostname ?? '127.0.0.1'
    const listening = yield* until(
      new Promise<{ port: number; hostname: string }>(resolve => {
        const server = runtime.serve(
          { port: options.port ?? 0, hostname, onListen: addr => resolve(addr) },
          async request => {
            if (handlers.isSocket(request)) {
              const decision = await handlers.upgrade(request)
              if (decision.kind === 'reject') {
                return decision.response
              }
              const { socket, response } = runtime.upgradeWebSocket(request)
              socket.addEventListener('open', () => decision.attach(rawOf(socket)))
              return response
            }
            return handlers.fetch(request)
          },
        )
        state.server = server
      }),
    )
    return {
      url: `http://${listening.hostname}:${listening.port}`,
      port: listening.port,
      hostname: listening.hostname,
    }
  },

  *stop() {
    const state = yield* useContext(StateRef)
    const { server } = state
    state.server = null
    if (server) {
      yield* until(server.shutdown())
    }
  },
}
