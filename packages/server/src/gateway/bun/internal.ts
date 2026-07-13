import { CoreErrors, Gateway, statusFor } from 'server:core'
import { operation, until, useContext, useScope } from 'std:effect'
import { asFailure, fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { dispatchRequest } from '../shared/handle'
import { closeSockets } from '../shared/realtime'
import { haltInflight, pauseGate, trackRequest } from '../shared/serve'

export const startAction = operation(function* (
  config: Partial<{ port: number; host: string; reusePort: boolean }>,
) {
  const ctx = yield* useContext(Gateway.context)
  const scope = yield* useScope()

  const fetch = async (request: Request, bunServer: AnyType): Promise<Response | undefined> => {
    const paused = await pauseGate(scope)
    if (paused) {
      return paused
    }

    // `dispatchRequest` delivers the Response via `deliver` — for a streaming action as soon as the
    // headers are known (while the body drains in the background), for a normal action once the value
    // is transformed. `trackRequest` runs dispatch IN THE BACKGROUND on the gateway scope (kept alive,
    // the stream paced by Bun's reads); we return as soon as the Response is ready.
    let resolveReady: (response: Response | undefined) => void = () => {}
    const ready = new Promise<Response | undefined>(resolve => {
      resolveReady = resolve
    })
    let settled = false
    const deliver = (response: Response | undefined) => {
      if (!settled) {
        settled = true
        resolveReady(response)
      }
    }

    trackRequest(scope, ctx, deliver, function* () {
      try {
        const upgraded = yield* Gateway.actions.upgrade(request, bunServer)
        if (upgraded) {
          deliver(undefined)
          return
        }
      } catch {
        // upgrade negotiation failed (e.g. no ws route) — fall through to REST (which 404s)
      }

      try {
        yield* dispatchRequest(request, null, deliver)
      } catch (error) {
        deliver(Response.json(asFailure(error), { status: statusFor(CoreErrors.BrokerInternal) }))
      }
    })

    return await ready
  }

  let server: AnyType
  try {
    server = Bun.serve({
      port: config.port ?? ctx.port,
      hostname: config.host ?? ctx.host,
      reusePort: config.reusePort ?? ctx.reusePort ?? false,
      idleTimeout: -1,

      fetch,
      websocket: {
        async open(ws: AnyType) {
          await scope.safeRun(() => Gateway.actions.onOpen(ws))
        },
        async message(ws: AnyType, message: AnyType) {
          await scope.safeRun(() => Gateway.actions.onMessage(ws, message))
        },
        async close(ws: AnyType, code: number, reason: string) {
          await scope.safeRun(() => Gateway.actions.onClose(ws, code, reason))
        },
      },
    })
  } catch (error) {
    return yield* fail(CoreErrors.BrokerInternal, String(error))
  }

  ctx.host = server.hostname
  ctx.port = server.port
  ctx.server = server
  ctx.started = true

  return { host: server.hostname, port: server.port }
})

export const destroyAction = operation(function* (opts?: { drainMs?: number }) {
  const ctx = yield* useContext(Gateway.context)
  const server = ctx.server

  if (!server) {
    ctx.started = false
    return
  }

  // halt every per-socket pump + terminate every live WS connection, then abort in-flight request
  // pumps — so nothing is left to keep the process alive
  yield* closeSockets(ctx)
  yield* haltInflight(ctx)

  const drainMs = opts?.drainMs ?? 30_000

  let drained = false
  // oxlint-disable-next-line promise/always-return
  const stopPromise = (server as AnyType).stop().then(() => {
    drained = true
  })
  const timeoutPromise = new Promise<void>(resolve => {
    setTimeout(resolve, drainMs)
  })

  yield* until(Promise.race([stopPromise, timeoutPromise]))

  if (!drained) {
    yield* until((server as AnyType).stop(true))
  }

  ctx.started = false
})
