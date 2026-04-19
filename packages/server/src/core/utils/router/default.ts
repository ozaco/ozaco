import { all, operation, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { addRoute, createRouter, findAllRoutes, removeRoute } from 'rou3'
import { compileRouter } from 'rou3/compiler'

import { DEFAULT_REST_METHODS, RouterTags } from '../../const'
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
  }, RouterTags.add),

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
  }, RouterTags.has),

  remove: operation(function* (method, pattern) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    removeRoute(ctx.router, method, pattern)
  }, RouterTags.remove),

  find: operation(function* (method, path) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    const foundRoute = ctx.compiled(method, path)

    if (!foundRoute) {
      return yield* fail('not-found', `${method}:${path}`)
    }

    return [foundRoute.data as symbol, foundRoute.params]
  }, RouterTags.find),

  optimize: operation(function* () {
    const ctx = yield* useContext(DefaultRouterDef.context)
    ctx.compiled = compileRouter(ctx.router, { normalize: true })
  }, RouterTags.optimize),

  transformer: operation(function* (transformer) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    yield* install(transformer)

    ctx.transformer = transformer
  }, RouterTags.transformer),

  mount: operation(function* (prefix, service) {
    const ctx = yield* useContext(DefaultRouterDef.context)
    const transformer = ctx.transformer

    for (const key of service.getKeys()) {
      const meta = service.meta.get(key)

      if (meta?.isRaw) {
        continue
      }

      if (meta?.allow && !meta.allow.includes(transformer)) {
        continue
      }
      if (meta?.deny && meta.deny.includes(transformer)) {
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

      ctx.handlers.set(sym, { handler: action, key })
      addRoute(ctx.router, restSettings.method, prefix + restSettings.path, sym)
    }

    ctx.compiled = compileRouter(ctx.router, { normalize: true })
  }, RouterTags.mount),
})
