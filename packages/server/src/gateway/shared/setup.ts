import type { GatewayDef } from 'server:core'

import type { MatchedRoute, RouterContext } from 'rou3'
import { createRouter } from 'rou3'
import { compileRouter } from 'rou3/compiler'

// shared initial context for every platform impl: listener state + the rou3 route table
export const setup = function* (options: GatewayDef.Options = {}) {
  const router: RouterContext<unknown> = createRouter()
  const compiled: (method: string, path: string) => MatchedRoute<unknown> | undefined =
    compileRouter(router, { normalize: true })

  const ctx: GatewayDef.Context = {
    port: options.port ?? 3000,
    host: options.host ?? '0.0.0.0',

    server: null,
    started: false,
    paused: false,

    router,
    compiled,
    handlers: new Map(),
    inflight: new Set(),

    statusMap: options.statusMap,
    maxBodyBytes: options.maxBodyBytes,
    simplify: options.simplify,
  }

  return ctx
}
