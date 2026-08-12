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
      } catch (error) {
        // an `authorize` refusal is an ANSWER (401/403) — only negotiation failures (e.g. no ws
        // route) fall through to REST (which 404s)
        const failure = asFailure(error)
        const tag = (failure as AnyType).error
        if (tag === CoreErrors.Unauthorized || tag === CoreErrors.Forbidden) {
          deliver(Response.json(failure, { status: statusFor(tag) }))
          return
        }
      }

      try {
        yield* dispatchRequest(request, deliver)
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
      // Streaming is the ONLY upload path, so Bun's 128MB default request cap would silently
      // truncate what the Node gateway streams fine. `maxBodyBytes` is the one authority on size;
      // absent it, the platform must not invent a second, lower one.
      maxRequestBodySize: ctx.maxBodyBytes ?? Number.MAX_SAFE_INTEGER,

      fetch,
      websocket: {
        async open(ws: AnyType) {
          await scope.run(() => Gateway.actions.onOpen(ws))
        },
        async message(ws: AnyType, message: AnyType) {
          await scope.run(() => Gateway.actions.onMessage(ws, message))
        },
        async close(ws: AnyType, code: number, reason: string) {
          await scope.run(() => Gateway.actions.onClose(ws, code, reason))
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

  // `destroy()` is a HARD teardown: the two calls above already force-closed every socket + pump, so
  // there is nothing left to gracefully drain. Default to an immediate stop — a positive `drainMs` is
  // opt-in for callers that still want a drain window (e.g. rolling deploys). A 30s default here made
  // every realtime server hang ~30s on Ctrl-C, because Bun's graceful `server.stop()` keeps waiting on
  // a realtime connection that `closeSockets` already terminated.
  const drainMs = opts?.drainMs ?? 0

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
