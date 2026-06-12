import type { Action, GatewayDef, Service } from 'server:core'
import { CoreErrors, Gateway, isAction, isService } from 'server:core'
import { all, ensure, operation, useContext } from 'std:effect'
import { fail } from 'std:result'

import { addRoute, findAllRoutes, removeRoute } from 'rou3'
import { compileRouter } from 'rou3/compiler'

import { isRoutableSetting } from './util'

export const addAction = operation(function* (method: string, pattern: string, sym: symbol) {
  const ctx = yield* useContext(Gateway.context)
  addRoute(ctx.router, method, pattern, sym)
})

export const hasAction = operation(function* (method: string, pattern: string, sym?: symbol) {
  const ctx = yield* useContext(Gateway.context)
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

export const removeAction = operation(function* (method: string, pattern: string) {
  const ctx = yield* useContext(Gateway.context)
  removeRoute(ctx.router, method, pattern)
})

export const findAction = operation(function* (method: string, path: string) {
  const ctx = yield* useContext(Gateway.context)
  const foundRoute = ctx.compiled(method, path)

  if (!foundRoute) {
    return yield* fail(CoreErrors.NotFound, `${method}:${path}`)
  }

  return [foundRoute.data, foundRoute.params] as [symbol, unknown]
})

export const optimizeAction = operation(function* () {
  const ctx = yield* useContext(Gateway.context)
  ctx.compiled = compileRouter(ctx.router, { normalize: true })
})

export const mountAction = operation(function* (prefix: string, target: Service | Action) {
  const ctx = yield* useContext(Gateway.context)
  const registeredSyms = new Set<symbol>()

  const register = (
    settings: GatewayDef.TransformerSetting[],
    inner: { key?: string; ident: string; action: Action },
  ): void => {
    for (const setting of settings) {
      const sym = Symbol(`${prefix}#${inner.ident}#${setting.method}`)

      const route: GatewayDef.RegisteredRoute = {
        sym,
        prefix,
        target,
        setting,
        action: inner.action,
      }
      if (inner.key !== undefined) {
        route.key = inner.key
      }

      ctx.handlers.set(sym, route)
      registeredSyms.add(sym)

      addRoute(ctx.router, setting.method, prefix + setting.path, sym)
    }
  }

  if (isAction(target)) {
    const settings = (yield* all(target.settings ?? [])).filter(s => isRoutableSetting(s))

    if (settings.length === 0) {
      return yield* fail(
        CoreErrors.MissingSettings,
        `action registered with prefix "${prefix}" has no rest or ws transformer settings`,
      )
    }

    register(settings, { ident: target.title ?? 'unknown', action: target })
  } else if (isService(target)) {
    for (const key of target.getKeys()) {
      const meta = target.getMeta(key)

      if (!meta) {
        continue
      }

      const settings = (yield* all(meta.settings ?? [])).filter(s => isRoutableSetting(s))

      if (settings.length === 0) {
        continue
      }

      const action = (target.actions as Record<string, Action>)[key]!

      register(settings, { key, ident: `${target.name}@${target.version}#${key}`, action })
    }
  }

  ctx.compiled = compileRouter(ctx.router, { normalize: true })

  yield* ensure(function* () {
    for (const sym of registeredSyms) {
      const route = ctx.handlers.get(sym)
      if (route) {
        removeRoute(ctx.router, route.setting.method, prefix + route.setting.path)
        ctx.handlers.delete(sym)
      }
    }
    ctx.compiled = compileRouter(ctx.router, { normalize: true })
  })
})

export const unmountAction = operation(function* (target: Service | Action) {
  const ctx = yield* useContext(Gateway.context)

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
