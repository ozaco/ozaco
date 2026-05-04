import type { ActionRequest, ActionResponse, Helpers, ServerContext } from 'server:core'
import {
  ActionRawRequestContext,
  ActionRawResponseContext,
  ActionRequestContext,
  ActionResponseContext,
  ActionSignalContext,
  Rest,
  Router,
  Server,
  ServerErrorCode,
  Ws,
  statusFor,
} from 'server:core'
import { operation, until, useContext, useScope } from 'std:effect'
import { install } from 'std:plugin'
import { asFailure, auto, fail, isFailure, isSuccess, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { BunRest, BunWs } from '..'
import { BunIsPausedRef, BunIsStartedRef, BunServerRef } from '../utils/contexts'
import { resolveActionHandler } from '../utils/resolve'

export const BunImpl = Server.implement({
  name: 'bun',
  version: '0.0.1',
  *setup(options: { port?: number | undefined; host?: string | undefined } = {}) {
    yield* install(BunRest)
    yield* install(BunWs)

    yield* BunServerRef.set(null)
    yield* BunIsStartedRef.set(false)
    yield* BunIsPausedRef.set(false)

    return { port: options.port ?? 3000, host: options.host ?? '0.0.0.0' }
  },
})

export const isStartedAction = operation(function* () {
  return (yield* BunIsStartedRef.get()) ?? false
})

export const pauseAction = operation(function* (cause) {
  yield* BunIsPausedRef.set(cause)
})

export const isPausedAction = operation(function* () {
  return (yield* BunIsPausedRef.get()) ?? false
})

export const resumeAction = operation(function* () {
  yield* BunIsPausedRef.set(false)
})

export const destroyAction = operation(function* (opts?: { drainMs?: number }) {
  const server = yield* BunServerRef.get()

  if (!server) {
    yield* BunIsStartedRef.set(false)
    return
  }

  const drainMs = opts?.drainMs ?? 30_000

  let drained = false
  // oxlint-disable-next-line promise/always-return
  const stopPromise = server.stop().then(() => {
    drained = true
  })
  const timeoutPromise = new Promise<void>(resolve => {
    setTimeout(resolve, drainMs)
  })

  yield* until(Promise.race([stopPromise, timeoutPromise]))

  if (!drained) {
    yield* until(server.stop(true))
  }

  yield* BunIsStartedRef.set(false)
})

export const startAction = operation(function* (config) {
  const ctx = yield* useContext(Server.context)
  const routerCtx = yield* useContext(Router.context)
  const scope = yield* useScope()

  const tag = 'server:bun@0.0.1'

  let server: AnyType

  const fetch = async (request: Request, bunServer: Bun.Server<unknown>) => {
    const isPaused = await scope.run(function* () {
      return yield* BunIsPausedRef.get()
    })

    if (isFailure(isPaused)) {
      return Response.json(fail(ServerErrorCode.ServerInternal, 'is paused failed', tag), {
        status: statusFor(ServerErrorCode.ServerInternal),
      })
    } else if (isSuccess(isPaused) && isPaused.value) {
      return Response.json(fail(ServerErrorCode.ServerPaused, '', isPaused.value, tag), {
        status: statusFor(ServerErrorCode.ServerPaused),
      })
    }

    const url = new URL(request.url)

    const result = await scope.safeRun(function* () {
      let actionReq: ActionRequest | null = null
      let actionRes: ActionResponse | null = null

      try {
        const upgradeResult = yield* Ws.actions.upgrade(request, bunServer)

        if (isSuccess(upgradeResult) && upgradeResult.value) {
          return
        }

        const [routeSymbol, routeParams] = yield* Router.actions.find(request.method, url.pathname)

        const entry = routerCtx.handlers.get(routeSymbol)
        if (!entry) {
          return yield* fail(
            ServerErrorCode.NotFound,
            `no handler for ${request.method}:${url.pathname}`,
          )
        }

        const transformerMeta: Helpers.TransformerMeta = {
          sym: entry.sym,
          key: entry.key,
          prefix: entry.prefix,
          target: entry.target,
          setting: entry.setting,
          params: (routeParams ?? {}) as Record<string, unknown>,
        }

        const internal = yield* Rest.actions.toInternal(request, null, transformerMeta)

        actionReq = internal[0]
        actionRes = internal[1]
        const body = internal[2]

        const handler = resolveActionHandler(entry.target, entry.key)

        const actionResult = yield* ActionRequestContext.with(actionReq, function* () {
          return yield* ActionResponseContext.with(actionRes!, function* () {
            return yield* ActionRawRequestContext.with(request, function* () {
              return yield* ActionRawResponseContext.with(null, function* () {
                return yield* ActionSignalContext.with(request.signal, function* () {
                  return yield* handler(body)
                })
              })
            })
          })
        })

        return yield* Rest.actions.fromInternal(
          actionReq,
          actionRes,
          auto(actionResult),
          transformerMeta,
        )
      } catch (error) {
        return yield* Rest.actions.fromInternal(actionReq, actionRes, asFailure(error), null)
      }
    })

    return unwrap(result)
  }

  try {
    server = Bun.serve({
      port: config.port ?? ctx.port,
      hostname: config.host ?? ctx.host,

      fetch,
      websocket: {
        async open(ws) {
          await scope.safeRun(function* () {
            yield* Ws.actions.onOpen(ws)
          })
        },
        async message(ws, message) {
          await scope.safeRun(function* () {
            yield* Ws.actions.onMessage(ws, message)
          })
        },
        async close(ws, code, reason) {
          await scope.safeRun(function* () {
            yield* Ws.actions.onClose(ws, code, reason)
          })
        },
      },
    })
  } catch (error) {
    yield* fail(ServerErrorCode.Unexpected, String(error))
  }

  ctx.host = server.hostname
  ctx.port = server.port

  yield* BunServerRef.set(server)
  yield* BunIsStartedRef.set(true)

  return { host: server.hostname, port: server.port } satisfies ServerContext
})
