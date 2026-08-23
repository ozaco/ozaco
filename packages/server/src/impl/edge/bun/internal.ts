// oxlint-disable import/exports-last
import type { EdgeDef } from 'server:core'
import { createContext, until, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { BunEdgeDef } from './types'

export const StateRef = createContext<BunEdgeDef.State>('server:impl/edge/bun')

export const driver: EdgeDef.Driver = {
  runtime: 'bun',

  *serve(options, handlers) {
    const state = yield* useContext(StateRef)

    const server = Bun.serve<BunEdgeDef.SocketData>({
      port: options.port ?? 0,
      hostname: options.hostname ?? '127.0.0.1',
      async fetch(request, bunServer) {
        if (handlers.isSocket(request)) {
          const decision = await handlers.upgrade(request)
          if (decision.kind === 'reject') {
            return decision.response
          }
          const data: BunEdgeDef.SocketData = {
            listeners: { message: [], close: [] },
            attach: decision.attach,
          }
          return bunServer.upgrade(request, { data })
            ? (undefined as AnyType)
            : new Response('upgrade failed', { status: 500 })
        }
        return handlers.fetch(request)
      },
      websocket: {
        open(ws) {
          const { data } = ws
          const raw: EdgeDef.RawSocket = {
            send: payload => {
              ws.send(payload)
            },
            close: (code, reason) => {
              ws.close(code, reason)
            },
            onMessage: listener => {
              data.listeners.message.push(listener)
            },
            onClose: listener => {
              data.listeners.close.push(listener)
            },
          }
          data.attach?.(raw)
        },
        message(ws, message) {
          const payload = typeof message === 'string' ? message : new Uint8Array(message)
          for (const listener of ws.data.listeners.message) {
            listener(payload)
          }
        },
        close(ws, code, reason) {
          for (const listener of ws.data.listeners.close) {
            listener(code, reason)
          }
        },
      },
    })
    state.server = server
    const hostname = String(server.hostname ?? options.hostname ?? '127.0.0.1')
    const port = Number(server.port)

    return { url: `http://${hostname}:${port}`, port, hostname }
  },

  *stop() {
    const state = yield* useContext(StateRef)

    if (state.server) {
      const { server } = state
      state.server = null
      yield* until(Promise.resolve(server.stop(true)))
    }
  },
}
