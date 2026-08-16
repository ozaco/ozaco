import { CoreErrors, GatewayAdapter, fromWebRequest, toWebResponse } from 'server:core'
import type { Edge, GatewayServeOptions } from 'server:core'
import { taskValue } from 'server:utils'
// oxlint-disable import/exports-last
import { createContext, ensure, operation, useScope } from 'std:effect'
import type { Context, Scope } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

/** The minimal Deno surface the adapter needs — injectable for tests and non-Deno hosts. */
export interface DenoLike {
  serve(
    options: {
      port?: number
      hostname?: string
      onListen?: (addr: { port: number; hostname: string }) => void
    },
    handler: (request: Request) => Response | Promise<Response>,
  ): {
    readonly addr: { readonly port: number; readonly hostname: string }
    shutdown(): Promise<void>
  }
  upgradeWebSocket(request: Request): { socket: AnyType; response: Response }
}

/** Override in tests / embedders; defaults to the global `Deno` when present. */
export const denoImpl: Context<DenoLike | undefined> = createContext<DenoLike | undefined>(
  'server:gateway/deno',
  (globalThis as AnyType).Deno as DenoLike | undefined,
)

const wireSocket = (input: {
  readonly scope: Scope
  readonly socket: AnyType
  readonly handlers: Edge.SocketHandlers
}): void => {
  const { scope, socket, handlers } = input
  const edge: Edge.Socket = {
    id: crypto.randomUUID(),
    send: data => {
      socket.send(data)
    },
    close: (code, reason) => {
      socket.close(code, reason)
    },
  }

  // oxlint-disable-next-line prefer-add-event-listener
  socket.onopen = () => {
    void scope.run(() => handlers.open(edge)).catch(() => {})
  }

  // oxlint-disable-next-line prefer-add-event-listener
  socket.onmessage = (event: AnyType) => {
    const data: string | Uint8Array =
      typeof event.data === 'string' ? event.data : new Uint8Array(event.data)

    void scope.run(() => handlers.message(edge, data)).catch(() => {})
  }

  // oxlint-disable-next-line prefer-add-event-listener
  socket.onclose = (event: AnyType) => {
    void scope
      .run(() => handlers.close(edge, event.code ?? 1000, event.reason ?? ''))
      .catch(() => {})
  }
}

/** The Deno runtime adapter — `Deno.serve` + `Deno.upgradeWebSocket` behind the edge seam. */
export const DenoGatewayAdapter = GatewayAdapter.implement<{ readonly name: string }, []>({
  name: 'deno-gateway-adapter',
  version: '0.1.0',
  *setup() {
    return { name: 'deno' }
  },
}).build({
  serve: operation(function* (options: GatewayServeOptions, edge: Edge.Handlers) {
    const scope = yield* useScope()
    const deno = yield* denoImpl.get()

    if (!deno) {
      return yield* fail(
        CoreErrors.Unsupported,
        'the deno gateway adapter needs the Deno global (or an injected denoImpl)',
      )
    }

    const handler = async (request: Request): Promise<Response> => {
      try {
        if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
          const decision = await taskValue(scope.run(() => edge.upgrade(fromWebRequest(request))))

          if (decision.kind === 'reject') {
            return new Response(null, { status: decision.status, headers: decision.headers ?? {} })
          }

          const { socket, response } = deno.upgradeWebSocket(request)

          wireSocket({ scope, socket, handlers: decision.handlers })

          return response
        }

        const response = await taskValue(scope.run(() => edge.fetch(fromWebRequest(request))))

        return toWebResponse(scope, response)
      } catch (error) {
        const message =
          typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message: unknown }).message)
            : 'internal error'

        return new Response(message, { status: 500 })
      }
    }

    const server = deno.serve(
      {
        port: options.port ?? 0,
        hostname: options.host ?? '127.0.0.1',
        // the gateway reports readiness itself — mute Deno.serve's default stdout banner
        onListen: () => {},
      },
      handler,
    )

    yield* ensure(() => {
      void server.shutdown()
    })

    const handle: Edge.Server = {
      port: server.addr.port,
      host: server.addr.hostname,
      stop: operation(function* () {
        void server.shutdown()
      }),
    }

    return handle
  }),
})
