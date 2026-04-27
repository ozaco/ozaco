import { all, operation, useContext } from 'std:effect'
import { fail } from 'std:result'

import type { MatchedRoute, RouterContext } from 'rou3'
import { addRoute, createRouter, findAllRoutes, removeRoute } from 'rou3'
import { compileRouter } from 'rou3/compiler'
import type { Helpers as CoreHelpers } from 'server:core'
import { isAction, isService, Router } from 'server:core'

import type { RegisteredRoute } from '../types'
import { isRestSetting } from '../utils/is'

export const DefaultRouterImpl = Router.implement({
  name: 'plugin:router',
  version: '0.0.1',

  // oxlint-disable-next-line require-yield
  *setup() {
    const router: RouterContext<unknown> = createRouter()
    const compiled: (method: string, path: string) => MatchedRoute<unknown> | undefined =
      compileRouter(router, { normalize: true })
    const handlers = new Map<symbol, RegisteredRoute>()

    return {
      router,
      compiled,
      handlers,
    }
  },
})

export const addAction = operation(function* (method, pattern, sym) {
  const ctx = yield* useContext(DefaultRouterImpl.context)

  addRoute(ctx.router, method, pattern, sym)
})

export const hasAction = operation(function* (method, pattern, sym) {
  const ctx = yield* useContext(DefaultRouterImpl.context)

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
})

export const removeAction = operation(function* (method, pattern) {
  const ctx = yield* useContext(DefaultRouterImpl.context)

  removeRoute(ctx.router, method, pattern)
})

export const findAction = operation(function* (method, path) {
  const ctx = yield* useContext(DefaultRouterImpl.context)

  const foundRoute = ctx.compiled(method, path)

  if (!foundRoute) {
    return yield* fail('not-found', `${method}:${path}`)
  }

  return [foundRoute.data, foundRoute.params] as [symbol, unknown]
})

export const optimizeAction = operation(function* () {
  const ctx = yield* useContext(DefaultRouterImpl.context)
  ctx.compiled = compileRouter(ctx.router, { normalize: true })
})

export const mountAction = operation(function* (prefix, target) {
  const ctx = yield* useContext(DefaultRouterImpl.context)

  const register = (
    settings: CoreHelpers.TransformerSetting[],
    inner: { key?: string; ident: string },
  ): void => {
    for (const setting of settings) {
      const sym = Symbol(`${prefix}#${inner.ident}#rest`)

      const route: RegisteredRoute = {
        sym,
        prefix,
        target,
        setting,
      }
      if (inner.key !== undefined) {
        route.key = inner.key
      }

      ctx.handlers.set(sym, route)

      addRoute(ctx.router, setting.method, prefix + setting.path, sym)
    }
  }

  if (isAction(target)) {
    const settings = (yield* all(target.settings ?? [])).filter(s => isRestSetting(s))

    if (settings.length === 0) {
      return yield* fail(
        'missing-settings',
        `action registered with prefix "${prefix}" has no rest transformer settings`,
      )
    }

    register(settings, { ident: target.title ?? 'unknown' })
  } else if (isService(target)) {
    for (const key of target.getKeys()) {
      const meta = target.getMeta(key)

      if (!meta) {
        continue
      }

      const settings = (yield* all(meta.settings ?? [])).filter(s => isRestSetting(s))

      if (settings.length === 0) {
        continue
      }

      register(settings, { key, ident: `${target.name}@${target.version}#${key}` })
    }
  }

  ctx.compiled = compileRouter(ctx.router, { normalize: true })
})

export const unmountAction = operation(function* (target) {
  const ctx = yield* useContext(DefaultRouterImpl.context)

  for (const [sym, entry] of ctx.handlers) {
    if (entry.target !== target) {
      continue
    }

    if (entry.setting.method && entry.setting.path) {
      removeRoute(ctx.router, entry.setting.method, entry.prefix + entry.setting.path)
    }

    ctx.handlers.delete(sym)
  }

  ctx.compiled = compileRouter(ctx.router, { normalize: true })
})
