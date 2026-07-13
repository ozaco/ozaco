import { CoreErrors, Gateway, statusFor } from 'server:core'
import { action, operation, useContext, useScope } from 'std:effect'
import { IO } from 'std:io'
import { asFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'

import type { WebSocketServer } from 'ws'

import { dispatchRequest } from '../shared/handle'
import { haltInflight, pauseGate, trackRequest } from '../shared/serve'

// adapt a Node request into a web-standard Request the shared transformer understands
const toRequest = async (req: IncomingMessage): Promise<Request> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }

  const method = req.method ?? 'GET'
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') {
      headers.set(key, value)
    } else if (Array.isArray(value)) {
      headers.set(key, value.join(', '))
    }
  }

  const hasBody = method !== 'GET' && method !== 'HEAD' && chunks.length > 0
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, {
    method,
    headers,
    ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
  })
}

// stream the response body to the node socket — works for both a buffered Response (JSON/text) and a
// live streaming body (the gateway's ReadableStream), and never corrupts binary. Backpressure flows:
// res.write() returning false parks the read loop until 'drain', which in turn parks the upstream
// pump via the body's desiredSize.
const writeResponse = async (res: ServerResponse, response: Response): Promise<void> => {
  res.statusCode = response.status
  for (const [key, value] of response.headers) {
    res.setHeader(key, value)
  }

  if (!response.body) {
    res.end()
    return
  }

  // pipe the body to the socket — `.pipe` handles backpressure (a slow socket pauses the source,
  // which parks the upstream pump via the body's desiredSize) and ends `res` when the source ends
  const source = Readable.fromWeb(response.body as AnyType)
  try {
    await new Promise<void>((resolve, reject) => {
      source.on('error', reject)
      res.on('error', reject)
      res.on('finish', resolve)
      source.pipe(res)
    })
  } catch {
    // body errored mid-stream (after headers are already sent) — drop the connection so the client
    // sees a truncated transfer rather than a clean, silently-incomplete response
    res.destroy()
  }
}

export const startAction = operation(function* (
  config: Partial<{ port: number; host: string; reusePort: boolean }>,
) {
  const ctx = yield* useContext(Gateway.context)
  const scope = yield* useScope()

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const paused = await pauseGate(scope)
    if (paused) {
      await writeResponse(res, paused)
      return
    }

    const request = await toRequest(req)

    // `dispatchRequest` delivers the Response via `deliver` — for a streaming action as soon as the
    // headers are known (while the body drains in the background), for a normal action once the value
    // is transformed. `trackRequest` runs dispatch in the background on the gateway scope (kept alive;
    // the stream paced by the socket's drain); we write the response when it arrives.
    let responded = false
    const deliver = (response: Response): void => {
      if (responded) {
        return
      }
      responded = true
      void writeResponse(res, response)
    }

    trackRequest(scope, ctx, deliver, function* () {
      try {
        yield* dispatchRequest(request, res, deliver)
      } catch (error) {
        deliver(Response.json(asFailure(error), { status: statusFor(CoreErrors.BrokerInternal) }))
      }
    })
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  // WebSocket upgrades: node:http has no built-in ws server, so bridge the raw `upgrade` socket to the
  // `ws` package (an OPTIONAL peer dep — lazily imported so the gateway starts without it), then funnel
  // its events through the SAME platform-agnostic Gateway.actions.onOpen/onMessage/onClose the Bun
  // gateway uses (registry + rooms + per-message RPC all shared).
  let wss: WebSocketServer | undefined
  const ensureWss = async (): Promise<WebSocketServer | undefined> => {
    if (wss) {
      return wss
    }
    try {
      const mod = await import('ws')
      wss = new mod.WebSocketServer({ noServer: true })
    } catch {
      wss = undefined
    }
    return wss
  }

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const hub = await ensureWss()
      if (!hub) {
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
      const found = await scope.safeRun(() => Gateway.actions.find('WS', url.pathname))
      if (!isSuccess(found) || !found.value) {
        socket.destroy()
        return
      }
      const [sym, params] = found.value as [symbol, unknown]
      const entry = ctx.handlers.get(sym)
      if (!entry) {
        socket.destroy()
        return
      }
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(req.headers)) {
        headers[key] = Array.isArray(value) ? value.join(', ') : (value ?? '')
      }
      // mint the socket id through IO (IO-first) BEFORE the handshake, so ws.data is set synchronously
      // in the handleUpgrade callback (no race with the first inbound message).
      const minted = await scope.safeRun(() => IO.actions.uuid())
      const id = isSuccess(minted) ? minted.value : ''
      hub.handleUpgrade(req, socket, head, nodeWs => {
        ;(nodeWs as AnyType).data = {
          id,
          url: url.href,
          headers,
          params,
          entry,
          controller: new AbortController(),
        }
        void scope.safeRun(() => Gateway.actions.onOpen(nodeWs))
        nodeWs.on('message', (data: AnyType, isBinary: boolean) => {
          void scope.safeRun(() =>
            Gateway.actions.onMessage(nodeWs, isBinary ? (data as unknown) : String(data)),
          )
        })
        nodeWs.on('close', (code: number, reason: AnyType) => {
          void scope.safeRun(() => Gateway.actions.onClose(nodeWs, code, String(reason ?? '')))
        })
      })
    })()
  })

  // Under node:cluster the primary shares one listening handle across workers automatically; for
  // standalone multi-process shared-port, `reusePort` enables kernel-level SO_REUSEPORT balancing.
  yield* action<void>(resolve => {
    server.listen(
      {
        port: config.port ?? ctx.port,
        host: config.host ?? ctx.host,
        reusePort: config.reusePort ?? ctx.reusePort ?? false,
      },
      () => resolve(),
    )
    return () => {}
  })

  // read the ACTUAL bound port from the listening socket so `port: 0` (ephemeral) reports the real
  // port the OS assigned — matching the Bun gateway's behaviour.
  const address = server.address()
  ctx.port =
    typeof address === 'object' && address !== null ? address.port : (config.port ?? ctx.port)
  ctx.host = config.host ?? ctx.host
  ctx.server = server
  ctx.started = true

  return { host: ctx.host, port: ctx.port }
})

export const destroyAction = operation(function* () {
  const ctx = yield* useContext(Gateway.context)
  const server = ctx.server

  if (!server) {
    ctx.started = false
    return
  }

  // abort in-flight request pumps first so an active stream cannot block close() below
  yield* haltInflight(ctx)

  // force-close any sockets still open so a slow/streaming client cannot keep close() hanging
  ;(server as AnyType).closeAllConnections?.()

  yield* action<void>((resolve, reject) => {
    ;(server as AnyType).close((error: unknown) => {
      if (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      } else {
        resolve()
      }
    })
    return () => {}
  })

  ctx.started = false
})

// `upgrade` is Bun's fetch-time upgrade action; Node upgrades via the http server's `upgrade` event
// (wired in startAction), so this satisfies the protocol but is never invoked on Node.
export const noUpgrade = operation(function* () {
  return false
})
