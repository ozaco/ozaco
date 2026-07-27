import type { GatewayDef } from 'server:core'
import { useScope } from 'std:effect'
import { IO } from 'std:io'

import type { MatchedRoute, RouterContext } from 'rou3'
import { createRouter } from 'rou3'
import { compileRouter } from 'rou3/compiler'

import { WS_MODE_ENV } from './const'

// shared initial context for every platform impl: listener state + the rou3 route table
export const setup = function* (options: GatewayDef.Options = {}) {
  const router: RouterContext<unknown> = createRouter()
  const compiled: (method: string, path: string) => MatchedRoute<unknown> | undefined =
    compileRouter(router, { normalize: true })

  // the install scope — `socket.spawn` runs per-socket background tasks here (halted on close).
  const scope = yield* useScope()

  // read once, not per frame: an unrecognised value is ignored rather than guessed at, so a typo
  // leaves every route on its own setting instead of silently flipping the whole deployment.
  const { ws } = yield* IO.actions.env(data => ({
    ws: String(data[WS_MODE_ENV] ?? '')
      .trim()
      .toLowerCase(),
  }))

  const ctx: GatewayDef.Context = {
    port: options.port ?? 3000,
    host: options.host ?? '0.0.0.0',

    scope,

    server: null,
    started: false,
    paused: false,

    router,
    compiled,
    handlers: new Map(),
    inflight: new Set(),

    sockets: new Map(),
    rooms: new Map(),
    channels: new Map(),
    wsMode: ws === 'session' || ws === 'message' ? ws : null,

    statusMap: options.statusMap,
    maxBodyBytes: options.maxBodyBytes,
    reusePort: options.reusePort,
    simplify: options.simplify,
  }

  return ctx
}
