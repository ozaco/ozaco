// oxlint-disable import/exports-last
import type { EdgeDef } from 'server:core'
import { ServerErrors } from 'server:core'
import { TRACE_SCOPE } from 'server:internal'
import type { Scope } from 'std:effect'
import { attempt, createContext, until, useContext, useScope } from 'std:effect'
import { Logger } from 'std:logger'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer as createHttpServer } from 'node:http'
import { Readable } from 'node:stream'

import type { Helpers } from './types/helpers'
import type { NodeEdgeDef } from './types/node'

export const StateRef = createContext<NodeEdgeDef.State>('server:impl/edge/node')

/** A node request as a web `Request` (body streamed, never buffered); `signal` aborts when the
 * client goes away before its response finished (Bun's `request.signal` does the same). */
const toRequest = (req: IncomingMessage, host: string, signal: AbortSignal): Request => {
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
    signal,
    // node needs `duplex` for streamed request bodies (not in the DOM typings)
    ...({ duplex: 'half' } as object),
  })
}

/**
 * A driver fault (a broken response pump) as one WARN line through the std `Logger` installed
 * where the edge listens (`logger: '@ozaco/server'`) — silent without one, and it never fails.
 */
const warnIn =
  (scope: Scope): Helpers.Warn =>
  (message, data) => {
    try {
      void scope.run(
        () =>
          attempt(function* () {
            if ((yield* Logger.context.get()) === undefined) {
              return
            }

            yield* Logger.actions.child({ logger: TRACE_SCOPE }, () =>
              Logger.actions.warn(message, data),
            )
          }),
        { detached: true },
      )
    } catch {
      // the edge's scope is gone: nothing left to log in
    }
  }

/** The request id a response carries, as log data (none when it has no `x-request-id`). */
const requestIdOf = (response: Response): Record<string, string> => {
  const requestId = response.headers.get('x-request-id')

  return requestId === null ? {} : { 'ozaco.request.id': requestId }
}

/**
 * Write a web `Response` to a node response (streamed bodies pumped chunk by chunk). A client
 * that is gone — before the headers or mid-body, even while the pump waits for `drain` — gets
 * nothing more: the body is CANCELLED (its pumps stop, the edge span ends). Headers node refuses
 * although a web `Response` allowed them (a control character in a value) answer a plain 500
 * instead of crashing the process; that and a pump breaking mid-body are reported through `warn`.
 */
export const write = async (
  response: Response,
  res: ServerResponse,
  writing: Helpers.Writing,
): Promise<void> => {
  const { gone, warn } = writing

  if (gone.aborted) {
    await response.body?.cancel().catch(() => {})
    return
  }

  try {
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  } catch (error) {
    warn('edge response refused by node', {
      'http.response.status_code': response.status,
      ...requestIdOf(response),
      error: asFailure(error),
    })
    await response.body?.cancel().catch(() => {})

    if (res.headersSent) {
      res.destroy()
    } else {
      res.writeHead(500, { 'content-type': 'text/plain' })
      res.end('internal error')
    }
    return
  }

  if (!response.body) {
    res.end()
    return
  }

  const reader = response.body.getReader()

  // the client left: the body is released at once (also while the pump waits for `drain`)
  const left = new Promise<void>(resolve => {
    gone.addEventListener(
      'abort',
      () => {
        void reader.cancel().catch(() => {})
        resolve()
      },
      { once: true },
    )
  })

  const pump = async (): Promise<void> => {
    const step = await reader.read()

    if (step.done || gone.aborted) {
      res.end()
      return
    }

    if (!res.write(step.value)) {
      await Promise.race([
        new Promise<void>(resolve => {
          res.once('drain', () => resolve())
        }),
        left,
      ])
    }

    return pump()
  }

  await pump().catch((error: unknown) => {
    warn('edge response pump failed', {
      'http.response.status_code': response.status,
      ...requestIdOf(response),
      error: asFailure(error),
    })
    res.end()
  })
}

/**
 * Answer a refused upgrade on the raw socket: the rejection as a whole HTTP response — its own
 * headers (x-request-id, traceresponse, oz-error) and its failure envelope, `content-length`
 * matching what is written — then close.
 */
const refuseUpgrade = async (
  socket: { end(data: string | Uint8Array): unknown; destroy(): unknown },
  response: Response,
): Promise<void> => {
  try {
    const body = new Uint8Array(await response.arrayBuffer())
    const lines = [...response.headers.entries()]
      .filter(([name]) => name !== 'content-length' && name !== 'transfer-encoding')
      .map(([name, value]) => `${name}: ${value}\r\n`)
      .join('')
    const head = `HTTP/1.1 ${response.status} Rejected\r\n${lines}content-length: ${body.byteLength}\r\nConnection: close\r\n\r\n`
    // header values are byte strings (latin1): one byte per character
    const bytes = new Uint8Array(head.length + body.byteLength)

    bytes.set(Uint8Array.from(head, char => char.codePointAt(0) ?? 0))
    bytes.set(body, head.length)
    socket.end(bytes)
  } catch {
    socket.destroy()
  }
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
    const warn = warnIn(yield* useScope())

    const server = createHttpServer((req, res) => {
      // a client gone before its response finished aborts the request: the dispatch halts
      // (`onDisconnect: 'cancel'`) and a body not written yet is cancelled (`write`)
      const gone = new AbortController()

      res.once('close', () => {
        if (!res.writableFinished) {
          gone.abort()
        }
      })

      const request = toRequest(req, req.headers.host ?? hostname, gone.signal)
      void handlers
        .fetch(request, req.socket.remoteAddress)
        .then(response => write(response, res, { gone: gone.signal, warn }))
        // the last resort: nothing the driver does may reject into the process
        .catch(() => res.destroy())
    })

    // sockets need the optional `ws` peer
    const wsModule = yield* until(import('ws').catch(() => null))

    if (wsModule) {
      const wss = new wsModule.WebSocketServer({ noServer: true })
      state.wss = wss

      server.on('upgrade', (req, socket, head) => {
        // a handshake whose client left while its verdict was pending aborts like a request
        const gone = new AbortController()
        socket.once('close', () => gone.abort())
        const request = toRequest(req, req.headers.host ?? hostname, gone.signal)
        if (!handlers.isSocket(request)) {
          socket.destroy()
          return
        }
        const settle = (decision: EdgeDef.Upgrade): void => {
          if (decision.kind === 'reject') {
            void refuseUpgrade(socket, decision.response)
            return
          }
          // `ws` completes the handshake synchronously, or aborts it (a malformed handshake: it
          // answers 400 itself) and the socket closes without the callback ever running — the
          // upgrade span then ends with that 400 instead of claiming a 101
          let upgraded = false
          socket.once('close', () => {
            if (!upgraded) {
              decision.failed(
                fail(ServerErrors.BadRequest, 'the websocket handshake did not complete'),
                400,
              )
            }
          })
          wss.handleUpgrade(req, socket, head, ws => {
            upgraded = true
            decision.attach(rawOf(ws))
          })
        }
        void handlers
          .upgrade(request, req.socket.remoteAddress)
          .then(settle, () => socket.destroy())
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
