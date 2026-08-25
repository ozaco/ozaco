// oxlint-disable import/exports-last
import type { EdgeDef } from 'server:core'
import { createContext, until, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createHttpServer } from 'node:http'
import { Readable } from 'node:stream'

import type { NodeEdgeDef } from './types'

export const StateRef = createContext<NodeEdgeDef.State>('server:impl/edge/node')

/** A node request as a web `Request` (body streamed, never buffered). */
const toRequest = (req: IncomingMessage, host: string): Request => {
  const headers = new Headers()

  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
    } else if (value !== undefined) {
      headers.set(key, value)
    }
  }

  const method = req.method ?? 'GET'
  const hasBody = method !== 'GET' && method !== 'HEAD'

  return new Request(`http://${host}${req.url ?? '/'}`, {
    method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as AnyType) : null,
    // node needs `duplex` for streamed request bodies (not in the DOM typings)
    ...({ duplex: 'half' } as object),
  })
}

/** Write a web `Response` to a node response (streamed bodies pumped chunk by chunk). */
export const write = async (response: Response, res: ServerResponse): Promise<void> => {
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()

  const pump = async (): Promise<void> => {
    const step = await reader.read()

    if (step.done) {
      res.end()
      return
    }

    if (!res.write(step.value)) {
      await new Promise<void>(resolve => {
        res.once('drain', () => resolve())
      })
    }

    return pump()
  }

  res.on('close', () => {
    void reader.cancel().catch(() => {})
  })

  await pump().catch(() => {
    res.end()
  })
}

/** `ws`'s `WebSocket` as the engine's raw socket. */
const rawOf = (ws: AnyType): EdgeDef.RawSocket => ({
  send: payload => {
    ws.send(payload)
  },
  close: (code, reason) => {
    ws.close(code, reason)
  },
  onMessage: listener => {
    ws.on('message', (data: AnyType, isBinary: boolean) => {
      listener(isBinary ? new Uint8Array(data) : String(data))
    })
  },
  onClose: listener => {
    ws.on('close', (code: number, reason: AnyType) => {
      listener(code, String(reason ?? ''))
    })
  },
})

export const driver: EdgeDef.Driver = {
  runtime: 'node',

  *serve(options, handlers) {
    const state = yield* useContext(StateRef)
    const hostname = options.hostname ?? '127.0.0.1'

    const server = createHttpServer((req, res) => {
      const request = toRequest(req, req.headers.host ?? hostname)
      void handlers.fetch(request).then(response => write(response, res))
    })

    // sockets need the optional `ws` peer
    const wsModule = yield* until(import('ws').catch(() => null))

    if (wsModule) {
      const wss = new wsModule.WebSocketServer({ noServer: true })
      state.wss = wss

      server.on('upgrade', (req, socket, head) => {
        const request = toRequest(req, req.headers.host ?? hostname)
        if (!handlers.isSocket(request)) {
          socket.destroy()
          return
        }
        const settle = (decision: EdgeDef.Upgrade): void => {
          if (decision.kind === 'reject') {
            socket.write(
              `HTTP/1.1 ${decision.response.status} Rejected\r\nConnection: close\r\n\r\n`,
            )
            socket.destroy()
            return
          }
          wss.handleUpgrade(req, socket, head, ws => {
            decision.attach(rawOf(ws))
          })
        }
        void handlers.upgrade(request).then(settle, () => socket.destroy())
      })
    }

    yield* until(
      new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(options.port ?? 0, hostname, () => resolve())
      }),
    )
    state.server = server
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : (options.port ?? 0)

    return { url: `http://${hostname}:${port}`, port, hostname }
  },

  *stop() {
    const state = yield* useContext(StateRef)
    const { server, wss } = state
    state.server = null
    state.wss = null

    if (wss) {
      for (const client of wss.clients ?? []) {
        client.terminate()
      }

      wss.close()
    }

    if (server) {
      server.closeAllConnections?.()

      yield* until(
        new Promise<void>(resolve => {
          server.close(() => resolve())
        }),
      )
    }
  },
}
