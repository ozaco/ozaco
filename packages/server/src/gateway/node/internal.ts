import { CoreErrors, Gateway, statusFor } from 'server:core'
import { action, operation, useContext, useScope } from 'std:effect'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'

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
    // Node has no built-in websocket server — reject upgrades with 426 (use BunGateway for ws)
    if (String(req.headers.upgrade).toLowerCase() === 'websocket') {
      res.statusCode = 426
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          error: 'upgrade-required',
          message: 'node gateway has no websocket support',
        }),
      )
      return
    }

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

  ctx.port = config.port ?? ctx.port
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

// node has no websocket server — these satisfy the protocol but never run a real upgrade
export const noUpgrade = operation(function* () {
  return false
})
export const noop = operation(function* () {})
