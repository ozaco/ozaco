import { CoreErrors, Gateway, statusFor } from 'server:core'
import { operation, until, useContext, useScope } from 'std:effect'
import { asFailure, fail, isFailure, isSuccess } from 'std:result'
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

    // `dispatchRequest` delivers the Response via `deliver` — for a streaming action as soon as the
    // headers are known (while the body drains in the background), for a normal action once the value
    // is transformed. So we run dispatch IN THE BACKGROUND on the gateway scope (kept alive, and the
    // stream paced by Bun's reads) and return as soon as the Response is ready. We do NOT await it.
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

    // track the background task so destroy() can halt a still-streaming request instead of hanging
    const task = scope.run(function* () {
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
    ctx.inflight.add(task)
    // oxlint-disable-next-line promise/always-return
    void task.then(() => {
      ctx.inflight.delete(task)
      // if the task ended without delivering (e.g. it was halted on shutdown before the action even
      // returned), unblock the handler so Bun doesn't keep the request in-flight forever
      deliver(new Response(null, { status: 503 }))
    })

    return await ready
  }

  let server: AnyType
  try {
    server = Bun.serve({
      port: config.port ?? ctx.port,
      hostname: config.host ?? ctx.host,
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

  // abort in-flight request pumps first: halting aborts each upstream fetch and (via the pump's
  // ensure) closes its response stream, so an active stream cannot block the drain below
  const inflight = [...ctx.inflight]
  ctx.inflight.clear()
  yield* until(Promise.all(inflight.map(task => task.halt())))

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
