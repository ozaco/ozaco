import { all, operation, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { addRoute, createRouter, findAllRoutes, removeRoute } from 'rou3'
import { compileRouter } from 'rou3/compiler'

import { DEFAULT_REST_METHODS } from '../../const'
import type { Helpers } from '../../types/helpers'
import type { RestTransformerOptions } from '../../types/transformer'
import { Rest } from '../transformer/rest'

import { Router } from './definition'

const DefaultRouterDef = Router.implement({
  name: 'default-router',
  version: '0.0.1',

  *setup() {
    const router = createRouter()
    const compiled = compileRouter(router, { normalize: true })
    const transformer = Rest

    yield* install(transformer)

    return {
      transformer,
      router,
      compiled,
      handlers: new Map(),
    }
  },
})

export const DefaultRouter: Helpers.DefaultRouter = DefaultRouterDef.build({
  add: operation(function* (method, pattern, sym) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    addRoute(ctx.router, method, pattern, sym)
  }),

  has: operation(function* (method, pattern, sym) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    const foundRoutes = findAllRoutes(ctx.router, method, pattern)

    if (!sym) {
      return foundRoutes.length > 0
    }

    for (const foundRoute of foundRoutes) {
      if (foundRoute.data === sym) {
        return true
      }
    }

    return false
  }),

  remove: operation(function* (method, pattern) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    removeRoute(ctx.router, method, pattern)
  }),

  find: operation(function* (method, path) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    const foundRoute = ctx.compiled(method, path)

    if (!foundRoute) {
      return yield* fail('not-found', `${method}:${path}`)
    }

    return [foundRoute.data as symbol, foundRoute.params]
  }),

  optimize: operation(function* () {
    const ctx = yield* useContext(DefaultRouterDef.context)
    ctx.compiled = compileRouter(ctx.router, { normalize: true })
  }),

  transformer: operation(function* (transformer) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    yield* install(transformer)

    ctx.transformer = transformer
  }),

  mount: operation(function* (prefix, service) {
    const ctx = yield* useContext(DefaultRouterDef.context)
    const transformer = ctx.transformer

    for (const key of service.getKeys()) {
      const meta = service.meta.get(key)

      if (
        meta?.isRaw ||
        (meta?.allow && !meta.allow.includes(transformer)) ||
        (meta?.deny && meta.deny.includes(transformer))
      ) {
        continue
      }

      const settings = yield* all(meta?.settings ?? [])

      const actionName = key.split('.').pop()!
      const restSettings = (settings.find(
        (setting: AnyType) => setting.transformer === transformer,
      ) ??
        DEFAULT_REST_METHODS[
          actionName as keyof typeof DEFAULT_REST_METHODS
        ]) as RestTransformerOptions

      if (!restSettings) {
        continue
      }

      const sym = Symbol(`${service.name}:${key}`)

      let action: AnyType = service.actions
      for (const part of key.split('.')) {
        action = action[part]
      }

      ctx.handlers.set(sym, { handler: action, key, settings: restSettings })
      addRoute(ctx.router, restSettings.method, prefix + restSettings.path, sym)
    }

    ctx.compiled = compileRouter(ctx.router, { normalize: true })
  }),

  unmount: operation(function* (service) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    for (const [sym, entry] of ctx.handlers) {
      if (entry.service !== service) {
        continue
      }
      if (entry.method && entry.path) {
        removeRoute(ctx.router, entry.method, entry.path)
      }
      ctx.handlers.delete(sym)
    }

    ctx.compiled = compileRouter(ctx.router, { normalize: true })
  }),
})
