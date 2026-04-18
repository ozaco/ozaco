import { operation, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { addRoute, createRouter, findAllRoutes, removeRoute } from 'rou3'
import { compileRouter } from 'rou3/compiler'

import { RouterTags } from '../../const'
import type { Helpers } from '../../types/helpers'
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

  // oxlint-disable-next-line require-yield
  mount: operation(function* (prefix, service) {
    for (const key of service.getKeys()) {
      const meta = service.meta.get(key)

      console.log(key, meta)
    }
  }, RouterTags.mount),
})
