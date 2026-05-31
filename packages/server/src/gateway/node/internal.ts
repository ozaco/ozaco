import { CoreErrors, Gateway, statusFor } from 'server:core'
import { operation, until, useContext, useScope } from 'std:effect'
import { isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:http'

import { dispatchRequest } from '../shared/handle'

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

const writeResponse = async (res: ServerResponse, response: Response): Promise<void> => {
  res.statusCode = response.status
  for (const [key, value] of response.headers) {
    res.setHeader(key, value)
  }
  res.end(await response.text())
}

export const startAction = operation(function* (config: Partial<{ port: number; host: string }>) {
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

    const paused = await scope.safeRun(() => Gateway.actions.isPaused())
    if (isFailure(paused)) {
      await writeResponse(
        res,
        Response.json(
          { error: CoreErrors.BrokerInternal, message: 'pause check failed' },
          { status: statusFor(CoreErrors.BrokerInternal) },
        ),
      )
      return
    }
    if (isSuccess(paused) && paused.value) {
      await writeResponse(
        res,
        Response.json(
          { error: CoreErrors.BrokerPaused, message: String(paused.value) },
          { status: statusFor(CoreErrors.BrokerPaused) },
        ),
      )
      return
    }

    const request = await toRequest(req)
    const result = await scope.safeRun(() => dispatchRequest(request, res))

    const response = isSuccess(result)
      ? result.value
      : Response.json(
          { error: CoreErrors.BrokerInternal, message: 'request failed' },
          { status: statusFor(CoreErrors.BrokerInternal) },
        )

    await writeResponse(res, response)
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  yield* until(
    new Promise<void>(resolve => {
      server.listen(config.port ?? ctx.port, config.host ?? ctx.host, () => {
        resolve()
      })
    }),
  )

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

  yield* until(
    new Promise<void>((resolve, reject) => {
      ;(server as AnyType).close((error: unknown) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)))
        } else {
          resolve()
        }
      })
    }),
  )

  ctx.started = false
})

// node has no websocket server — these satisfy the protocol but never run a real upgrade
export const noUpgrade = operation(function* () {
  return false
})
export const noop = operation(function* () {})
