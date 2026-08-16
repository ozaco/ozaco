import { CoreErrors, GatewayAdapter } from 'server:core'
import type { Edge, EdgeRequest, EdgeResponse, GatewayServeOptions, Meta } from 'server:core'
import { taskValue } from 'server:utils'
import { attempt, each, ensure, flow, operation, until, useScope, withResolvers } from 'std:effect'
import type { Scope } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

type NodeRequest = AnyType
type NodeResponse = AnyType

const headersOf = (raw: Record<string, string | string[] | undefined>): Meta => {
  const headers: Meta = {}

  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      headers[key] = value
    } else if (Array.isArray(value)) {
      headers[key] = value.join(', ')
    }
  }

  return headers
}

const toEdgeRequest = (request: NodeRequest): EdgeRequest => ({
  method: String(request.method ?? 'GET'),
  url: String(request.url ?? '/'),
  headers: headersOf(request.headers ?? {}),
  body:
    request.method === 'GET' || request.method === 'HEAD'
      ? undefined
      : flow<Uint8Array, unknown>(request as AsyncIterable<Uint8Array>),
})

const writeResponse = (input: {
  readonly scope: Scope
  readonly response: EdgeResponse
  readonly res: NodeResponse
}): void => {
  const { scope, response, res } = input

  res.writeHead(response.status, response.headers)

  if (response.body === undefined) {
    res.end()

    return
  }

  if (response.body instanceof Uint8Array) {
    res.end(response.body)

    return
  }

  const body = response.body

  void scope.run(function* () {
    const outcome = yield* attempt(function* () {
      for (const chunk of yield* each(body)) {
        res.write(chunk)
        yield* each.next()
      }
    })

    void outcome
    res.end()
    // (failure closes already produced whatever bytes made it out — the connection just ends)
  })
}

const wireSocket = (input: {
  readonly scope: Scope
  readonly ws: AnyType
  readonly handlers: AnyType
}): void => {
  const { scope, ws, handlers } = input
  const socket: Edge.Socket = {
    id: crypto.randomUUID(),
    send: data => {
      ws.send(data)
    },
    close: (code, reason) => {
      ws.close(code, reason)
    },
    ping: () => {
      ws.ping()
    },
  }

  void scope.run(() => handlers.open(socket)).catch(() => {})

  ws.on('message', (data: AnyType, isBinary: boolean) => {
    const payload: string | Uint8Array = isBinary ? new Uint8Array(data) : data.toString()

    void scope.run(() => handlers.message(socket, payload)).catch(() => {})
  })

  ws.on('close', (code: number, reason: AnyType) => {
    void scope.run(() => handlers.close(socket, code, String(reason ?? ''))).catch(() => {})
  })

  ws.on('pong', () => {
    const pong = handlers.pong

    if (pong) {
      void scope.run(() => pong(socket)).catch(() => {})
    }
  })
}

/** The Node runtime adapter — `node:http` + the optional `ws` peer for upgrades. */
export const NodeGatewayAdapter = GatewayAdapter.implement<{ readonly name: string }, []>({
  name: 'node-gateway-adapter',
  version: '0.1.0',
  *setup() {
    return { name: 'node' }
  },
}).build({
  serve: operation(function* (options: GatewayServeOptions, edge: Edge.Handlers) {
    const scope = yield* useScope()
    const http = yield* until(import('node:http'))
    const wsImport = yield* attempt(() => until(import('ws')))
    const wss = isFailure(wsImport)
      ? undefined
      : new wsImport.value.WebSocketServer({ noServer: true })

    const server = http.createServer((req: NodeRequest, res: NodeResponse) => {
      void taskValue(scope.run(() => edge.fetch(toEdgeRequest(req)))).then(
        response => {
          writeResponse({ scope, response, res })

          return undefined
        },
        (error: unknown) => {
          res.writeHead(500, { 'content-type': 'text/plain' })
          res.end(
            typeof error === 'object' && error && 'message' in error
              ? String((error as { message: unknown }).message)
              : 'internal error',
          )
        },
      )
    })

    server.on('upgrade', (req: NodeRequest, socket: AnyType, head: AnyType) => {
      const reject = (status: number) => {
        socket.write(`HTTP/1.1 ${status} Rejected\r\nconnection: close\r\n\r\n`)
        socket.destroy()
      }

      void taskValue(scope.run(() => edge.upgrade(toEdgeRequest(req)))).then(
        decision => {
          if (decision.kind === 'reject') {
            reject(decision.status)

            return undefined
          }

          if (!wss) {
            reject(501)

            return undefined
          }

          wss.handleUpgrade(req, socket, head, (ws: AnyType) => {
            wireSocket({ scope, ws, handlers: decision.handlers })
          })

          return undefined
        },
        () => {
          reject(500)
        },
      )
    })

    const listening = withResolvers<void>()
    const host = options.host ?? '127.0.0.1'

    server.on('error', (error: Error) => listening.reject(error))
    server.listen(options.port ?? 0, host, () => listening.resolve(undefined as void))

    yield* listening.operation

    const address = server.address()

    if (!address || typeof address === 'string') {
      return yield* fail(CoreErrors.Configuration, 'node server did not report a port')
    }

    yield* ensure(() => {
      server.close()
      wss?.close()
    })

    const handle: Edge.Server = {
      port: address.port,
      host,
      stop: operation(function* () {
        server.close()
        wss?.close()
      }),
    }

    return handle
  }),
})
