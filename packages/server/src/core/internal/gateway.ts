import { instanceId, moduleLogger } from 'server:utils'
import { attempt, operation, sleep, useScope } from 'std:effect'
import { fail } from 'std:result'

import { createRouter, addRoute, removeRoute } from 'rou3'

import { Broker, Gateway, GatewayAdapter } from '../definition'
import { CoreErrors } from '../errors'
import type {
  EdgeDecorator,
  EdgePreflight,
  GatewayInfo,
  GatewayOptions,
  GatewayServeOptions,
  SocketRoute,
} from '../types/gateway'
import type { Service } from '../types/service'

import { GatewayRef } from './edge/context'
import type { GatewayCtx, RouteTarget } from './edge/context'
import { handleFetch, handleUpgrade } from './edge/engine'
import { applyFanout, createSocketRegistry, GW_FANOUT } from './edge/sockets'
import type { FanoutPayload } from './edge/sockets'

const DEFAULT_MAX_BODY = 16 * 1024 * 1024
const DRAIN_POLL_MS = 20
const DRAIN_MAX_MS = 3000

const joinPath = (prefix: string, path: string): string => {
  const cleanPrefix = prefix === '/' ? '' : prefix.replace(/\/$/u, '')
  const cleanPath = path.startsWith('/') ? path : `/${path}`

  if (cleanPath === '/') {
    return cleanPrefix === '' ? '/' : cleanPrefix
  }

  return `${cleanPrefix}${cleanPath}`
}

const requireCtx = operation(function* () {
  return yield* GatewayRef.expect()
})

const infoOf = (ctx: GatewayCtx): GatewayInfo => {
  const server = ctx.state.server

  if (!server) {
    return { port: 0, host: '', url: '' }
  }

  return { port: server.port, host: server.host, url: `http://${server.host}:${server.port}` }
}

/**
 * The edge ENGINE — the single Gateway implementation. Owns routing, REST/SSE/multipart/WS
 * transforms, the request-id echo, pause/drain and the socket registry; a per-runtime
 * {@link GatewayAdapter} impl (bun/node/deno) must be installed before `start`.
 */
export const DefaultGateway = Gateway.implement<GatewayCtx, [GatewayOptions?]>({
  name: 'default-gateway',
  version: '0.1.0',
  *setup(options = {}) {
    const scope = yield* useScope()
    const log = yield* moduleLogger('server:core/gateway')
    const gatewayId = yield* instanceId()

    const ctx: GatewayCtx = {
      name: options.name ?? 'gateway',
      gatewayId,
      debug: options.debug ?? false,
      maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY,
      router: createRouter<RouteTarget>(),
      socketRouter: createRouter<SocketRoute>(),
      mounts: new Map(),
      bindings: new Map(),
      sockets: createSocketRegistry(),
      decorators: [],
      hooks: { preflight: undefined },
      idle:
        options.idle === false
          ? undefined
          : {
              ttlMs: options.idle?.ttlMs ?? 60_000,
              pingMs: options.idle?.pingMs ?? 20_000,
            },
      log,
      scope,
      state: { server: undefined, started: false, paused: false, inflight: 0 },
    }

    yield* GatewayRef.set(ctx)
    yield* log.debug('gateway ready', { gatewayId })

    return ctx
  },
}).build({
  start: operation(function* (options?: GatewayServeOptions) {
    const ctx = yield* requireCtx()

    if (ctx.state.started) {
      return yield* fail(CoreErrors.Configuration, 'gateway is already started')
    }

    const server = yield* GatewayAdapter.actions.serve(options ?? {}, {
      fetch: handleFetch,
      upgrade: handleUpgrade,
    })

    ctx.state.server = server
    ctx.state.started = true

    // cross-replica room/broadcast relay — silently skipped when no broker is installed
    yield* attempt(() =>
      Broker.actions.on(GW_FANOUT, payload => {
        applyFanout(ctx.sockets, ctx.gatewayId, payload as FanoutPayload)
      }),
    )

    const info = infoOf(ctx)

    yield* ctx.log.info('gateway listening', { url: info.url })

    return info
  }),

  stop: operation(function* () {
    const ctx = yield* requireCtx()
    const server = ctx.state.server

    ctx.state.started = false
    ctx.state.server = undefined

    let waited = 0

    while (ctx.state.inflight > 0 && waited < DRAIN_MAX_MS) {
      yield* sleep(DRAIN_POLL_MS)
      waited += DRAIN_POLL_MS
    }

    if (server) {
      yield* server.stop()
    }

    yield* ctx.log.info('gateway stopped', { drainedMs: waited })
  }),

  isStarted: operation(function* () {
    const ctx = yield* requireCtx()

    return ctx.state.started
  }),

  pause: operation(function* () {
    const ctx = yield* requireCtx()

    ctx.state.paused = true

    yield* ctx.log.warn('gateway paused', {})
  }),

  resume: operation(function* () {
    const ctx = yield* requireCtx()

    ctx.state.paused = false

    yield* ctx.log.info('gateway resumed', {})
  }),

  mount: operation(function* (prefix: string, service: Service) {
    const ctx = yield* requireCtx()

    if (ctx.mounts.has(prefix)) {
      return yield* fail(CoreErrors.Configuration, `prefix "${prefix}" is already mounted`)
    }

    for (const [actionKey, action] of Object.entries(service.actions)) {
      const route = action.meta.route

      if (!route) {
        continue
      }

      addRoute(ctx.router, route.method, joinPath(prefix, route.path), {
        service,
        actionKey,
        action,
      })
    }

    ctx.mounts.set(prefix, service)

    yield* ctx.log.debug('service mounted', { prefix, service: service.name })
  }),

  unmount: operation(function* (prefix: string) {
    const ctx = yield* requireCtx()
    const service = ctx.mounts.get(prefix)

    if (!service) {
      return
    }

    for (const action of Object.values(service.actions)) {
      const route = action.meta.route

      if (route) {
        removeRoute(ctx.router, route.method, joinPath(prefix, route.path))
      }
    }

    ctx.mounts.delete(prefix)

    yield* ctx.log.debug('service unmounted', { prefix, service: service.name })
  }),

  socket: operation(function* (path: string, route: SocketRoute) {
    const ctx = yield* requireCtx()

    addRoute(ctx.socketRouter, 'WS', path, route)

    yield* ctx.log.debug('socket route added', { path })
  }),

  decorate: operation(function* (decorator: EdgeDecorator) {
    const ctx = yield* requireCtx()

    ctx.decorators.push(decorator)
  }),

  preflight: operation(function* (handler: EdgePreflight) {
    const ctx = yield* requireCtx()

    ctx.hooks.preflight = handler
  }),

  info: operation(function* () {
    const ctx = yield* requireCtx()

    return infoOf(ctx)
  }),
})
