import { createContext, operation, until, useContext, useScope } from 'std:effect'
import { asFailure, auto, fail, isFailure, isSuccess, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import type { ServerContext } from 'server:core'
import { Router, Server, statusFor } from 'server:core'
import type { ActionRequest, ActionResponse } from 'server:service'

export const BunServerRef = createContext<AnyType>('bun:server:ref')
export const BunIsStartedRef = createContext<boolean>('bun:server:is-started')
export const BunIsPausedRef = createContext<false | string>('bun:server:is-paused')

export const BunServer = Server.implement({
  name: 'bun',
  version: '0.0.1',
  *setup() {
    yield* BunServerRef.set(null)
    yield* BunIsStartedRef.set(false)
    yield* BunIsPausedRef.set(false)

    return { port: 3000, host: '0.0.0.0' }
  },
}).build({
  start: operation(function* (config) {
    const ctx = yield* useContext(Server.context)
    const scope = yield* useScope()

    const routerCtx = yield* useContext(Router.context)

    const tag = 'server:bun@0.0.1'

    let server: AnyType

    try {
      server = Bun.serve({
        port: config.port ?? ctx.port,
        hostname: config.host ?? ctx.host,
        async fetch(req) {
          const isPaused = await scope.run(function* () {
            return yield* BunIsPausedRef.get()
          })

          if (isFailure(isPaused)) {
            return Response.json(fail('server-internal', 'is paused failed', tag), {
              status: statusFor('server-internal'),
            })
          } else if (isSuccess(isPaused) && isPaused.value) {
            return Response.json(fail('server-paused', '', isPaused.value, tag), {
              status: statusFor('server-paused'),
            })
          }

          const url = new URL(req.url)

          const result = await scope.safeRun(function* () {
            const CurrentTransformer = routerCtx.transformer
            let actionReq: ActionRequest | null = null
            let actionRes: ActionResponse | null = null

            try {
              const [routeSymbol, routeParams] = yield* Router.actions.find(
                req.method,
                url.pathname,
              )

              const entry = routerCtx.handlers.get(routeSymbol)
              if (!entry) {
                return yield* fail('not-found', `no handler for ${req.method}:${url.pathname}`)
              }

              const transformerMeta = {
                entry: entry.key,
                params: routeParams as Record<string, unknown>,
                settings: entry.settings,
              }

              const internal = yield* CurrentTransformer.actions.toInternal(
                req,
                null,
                transformerMeta,
              )

              actionReq = internal[0]
              actionRes = internal[1]

              const actionCtx = yield* CurrentTransformer.actions.toContext(
                actionReq,
                actionRes,
                transformerMeta,
              )

              const actionResult = yield* entry.handler(actionCtx)

              return yield* CurrentTransformer.actions.fromInternal(
                actionReq,
                actionRes,
                auto(actionResult),
                transformerMeta,
              )
            } catch (error) {
              return yield* CurrentTransformer.actions.fromInternal(
                actionReq,
                actionRes,
                asFailure(error),
                null,
              )
            }
          })

          return unwrap(result)
        },
      })
    } catch (error) {
      yield* fail('unexpected', String(error))
    }

    ctx.host = server.hostname
    ctx.port = server.port

    yield* BunServerRef.set(server)
    yield* BunIsStartedRef.set(true)

    return { host: server.hostname, port: server.port } as ServerContext
  }),

  isStarted: operation(function* () {
    return (yield* BunIsStartedRef.get()) ?? false
  }),

  pause: operation(function* (cause) {
    yield* BunIsPausedRef.set(cause)
  }),

  isPaused: operation(function* () {
    return (yield* BunIsPausedRef.get()) ?? false
  }),

  resume: operation(function* () {
    yield* BunIsPausedRef.set(false)
  }),

  destroy: operation(function* () {
    const server = yield* BunServerRef.get()

    if (server) {
      yield* until(server.stop(true))
    }

    yield* BunIsStartedRef.set(false)
  }),
})
