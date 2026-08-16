import { GatewayAdapter, fromWebRequest, toWebResponse } from 'server:core'
import type { Edge, GatewayServeOptions } from 'server:core'
import { taskValue } from 'server:utils'
import { ensure, operation, useScope } from 'std:effect'
import type { Scope } from 'std:effect'
import type { AnyType } from 'std:shared'

interface SocketData {
  readonly id: string
  readonly handlers: Edge.SocketHandlers
}

// NOTE: a Task's promise resolves the RAW value and REJECTS with the Failure — adapters live in
// plain async land, so every scope.run() here is try/caught (and fire-and-forget runs .catch()).
const messageOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message: unknown }).message)
    : 'internal error'

const dataOf = (ws: AnyType): SocketData => ws.data as SocketData

const edgeSocketOf = (ws: AnyType): Edge.Socket => ({
  id: dataOf(ws).id,
  send: data => {
    ws.send(data)
  },
  close: (code, reason) => {
    ws.close(code, reason)
  },
  ping: () => {
    ws.ping()
  },
})

const normalizeMessage = (message: string | Uint8Array | ArrayBuffer): string | Uint8Array => {
  if (typeof message === 'string') {
    return message
  }

  return message instanceof Uint8Array ? message : new Uint8Array(message)
}

const buildServer = (input: {
  readonly scope: Scope
  readonly options: GatewayServeOptions
  readonly edge: Edge.Handlers
}) => {
  const { scope, options, edge } = input
  const sockets = new Map<AnyType, Edge.Socket>()

  return Bun.serve({
    port: options.port ?? 0,
    hostname: options.host ?? '127.0.0.1',

    fetch: async (request, server) => {
      try {
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const decision = await taskValue(scope.run(() => edge.upgrade(fromWebRequest(request))))

          if (decision.kind === 'reject') {
            return new Response(null, { status: decision.status, headers: decision.headers ?? {} })
          }

          const data: SocketData = { id: crypto.randomUUID(), handlers: decision.handlers }
          const upgraded = server.upgrade(request, { data } as AnyType)

          return upgraded ? undefined : new Response('upgrade failed', { status: 500 })
        }

        const response = await taskValue(scope.run(() => edge.fetch(fromWebRequest(request))))

        return toWebResponse(scope, response)
      } catch (error) {
        return new Response(messageOf(error), { status: 500 })
      }
    },

    websocket: {
      open(ws) {
        const socket = edgeSocketOf(ws)

        sockets.set(ws, socket)
        void scope.run(() => dataOf(ws).handlers.open(socket)).catch(() => {})
      },
      message(ws, message) {
        const socket = sockets.get(ws)

        if (socket) {
          void scope
            .run(() => dataOf(ws).handlers.message(socket, normalizeMessage(message)))
            .catch(() => {})
        }
      },
      close(ws, code, reason) {
        const socket = sockets.get(ws)

        sockets.delete(ws)

        if (socket) {
          void scope.run(() => dataOf(ws).handlers.close(socket, code, reason)).catch(() => {})
        }
      },
      pong(ws) {
        const socket = sockets.get(ws)
        const pong = dataOf(ws).handlers.pong

        if (socket && pong) {
          void scope.run(() => pong(socket)).catch(() => {})
        }
      },
    },
  })
}

/** The Bun runtime adapter — `Bun.serve` + native WebSocket upgrade behind the single edge seam. */
export const BunGatewayAdapter = GatewayAdapter.implement<{ readonly name: string }, []>({
  name: 'bun-gateway-adapter',
  version: '0.1.0',
  *setup() {
    return { name: 'bun' }
  },
}).build({
  serve: operation(function* (options: GatewayServeOptions, edge: Edge.Handlers) {
    const scope = yield* useScope()
    const server = buildServer({ scope, options, edge })

    yield* ensure(() => {
      server.stop(true)
    })

    const handle: Edge.Server = {
      port: server.port ?? 0,
      host: options.host ?? '127.0.0.1',
      stop: operation(function* () {
        server.stop(true)
      }),
    }

    return handle
  }),
})
