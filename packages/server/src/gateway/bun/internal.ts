import { CoreErrors, Gateway, statusFor } from 'server:core'
import { operation, until, useContext, useScope } from 'std:effect'
import { fail, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import { dispatchRequest } from '../shared/handle'

export const startAction = operation(function* (config: Partial<{ port: number; host: string }>) {
  const ctx = yield* useContext(Gateway.context)
  const scope = yield* useScope()

  const fetch = async (request: Request, bunServer: AnyType): Promise<Response | undefined> => {
    const paused = await scope.safeRun(() => Gateway.actions.isPaused())

    if (isFailure(paused)) {
      return Response.json(
        { error: CoreErrors.BrokerInternal, message: 'pause check failed' },
        { status: statusFor(CoreErrors.BrokerInternal) },
      )
    }
    if (isSuccess(paused) && paused.value) {
      return Response.json(
        { error: CoreErrors.BrokerPaused, message: String(paused.value) },
        { status: statusFor(CoreErrors.BrokerPaused) },
      )
    }

    const result = await scope.safeRun(() =>
      operation(function* () {
        try {
          const upgraded = yield* Gateway.actions.upgrade(request, bunServer)
          if (upgraded) {
            return undefined
          }
        } catch {
          // upgrade negotiation failed (e.g. no ws route) — fall through to REST (which 404s)
        }

        return yield* dispatchRequest(request, null)
      })(),
    )

    if (isSuccess(result)) {
      return result.value as Response | undefined
    }
    return Response.json(
      { error: CoreErrors.BrokerInternal, message: 'request failed' },
      { status: statusFor(CoreErrors.BrokerInternal) },
    )
  }

  let server: AnyType
  try {
    server = Bun.serve({
      port: config.port ?? ctx.port,
      hostname: config.host ?? ctx.host,

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
