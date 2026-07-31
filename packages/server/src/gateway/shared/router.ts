import type { Action, GatewayDef, Service } from 'server:core'
import { CoreErrors, Gateway, isAction, isService } from 'server:core'
import { all, ensure, operation, useContext } from 'std:effect'
import { fail } from 'std:result'

import { addRoute, createRouter, findAllRoutes, removeRoute } from 'rou3'
import { compileRouter } from 'rou3/compiler'

import { isRoutableSetting } from './util'

/** The pseudo-method claims live under in the claims router — never a real HTTP method. */
const CLAIM = 'CLAIM'

const depthOf = (prefix: string): number => prefix.split('/').filter(Boolean).length

/**
 * Rebuild the subtree-claim table from the handlers map. A mount claims its whole subtree: a
 * request underneath `/kb/files` may only be answered by routes mounted at `/kb/files` or deeper —
 * see the guard in {@link findAction}. Kept as a second rou3 router so a param-carrying prefix
 * (`/apps/:appId/roles`) claims correctly, and rebuilt wholesale wherever the route table changes:
 * a refcount over prefixes two mounts can share is exactly the bookkeeping that drifts.
 */
const rebuildClaims = (ctx: GatewayDef.Context): void => {
  const claims = createRouter()
  const prefixes = new Set<string>()
  for (const route of ctx.handlers.values()) {
    prefixes.add(route.prefix)
  }
  for (const prefix of prefixes) {
    // a root mount ('' / '/') claims nothing — there is no outer route to shadow
    if (depthOf(prefix) === 0) {
      continue
    }
    addRoute(claims, CLAIM, prefix, prefix)
    addRoute(claims, CLAIM, `${prefix}/**`, prefix)
  }
  ctx.claims = claims
}

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

  /**
   * A mount owns its subtree, for EVERY method. Static-over-param already sends `GET /kb/files` to
   * the resource mounted there rather than the outer `GET /kb/:id`; but a method the inner mount
   * did NOT define used to fall through — `PATCH /kb/files` became `kb.update(id: 'files')`, a
   * data-dependent surprise no caller intends. So when a strictly deeper mounted prefix covers the
   * path than the matched route's own, the answer is NotFound: the inner mount shadows the outer
   * one symmetrically instead of leaking through method by method.
   *
   * `OPTIONS` is exempt: a preflight is not resource access, so the danger shadowing guards against
   * does not exist — while the guard itself would 404 the CORS `OPTIONS /**` route (a root mount)
   * on exactly the mounted paths a browser must preflight before it can call them at all.
   */
  const route = ctx.handlers.get(foundRoute.data as symbol)
  if (route !== undefined && method !== 'OPTIONS') {
    const normal = path.length > 1 ? path.replace(/\/+$/u, '') : path
    const owned = depthOf(route.prefix)
    for (const claim of findAllRoutes(ctx.claims, CLAIM, normal)) {
      if (depthOf(claim.data as string) > owned) {
        return yield* fail(CoreErrors.NotFound, `${method}:${path}`)
      }
    }
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

  /**
   * One address, one owner — refused rather than overwritten.
   *
   * `addRoute` overwrites in silence, so mounting a service beside a resource that had already
   * claimed the same pattern left half the app dark and said nothing. This is the same
   * claim-then-commit shape the broker's `register` uses; a partially mounted service is worse
   * than a refused one, which is why the `ensure` below rolls the whole mount back.
   */
  const taken = new Map<string, string>()
  for (const route of ctx.handlers.values()) {
    taken.set(`${route.setting.method} ${route.prefix}${route.setting.path}`, route.prefix)
  }

  const claim = (method: string, pattern: string, ident: string): string | undefined =>
    taken.has(`${method} ${pattern}`)
      ? `${method} ${pattern}`
      : (taken.set(`${method} ${pattern}`, ident), undefined)

  const collisions: string[] = []

  const register = (
    settings: GatewayDef.TransformerSetting[],
    inner: { key?: string; ident: string; action: Action },
  ): void => {
    for (const setting of settings) {
      const clash = claim(setting.method, prefix + setting.path, inner.ident)
      if (clash !== undefined) {
        collisions.push(clash)
        continue
      }

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
    for (const [key, action] of yield* target.actions._list()) {
      const settings = (yield* all(action.settings ?? [])).filter(s => isRoutableSetting(s))

      if (settings.length === 0) {
        continue
      }

      register(settings, { key, ident: `${target.name}@${target.version}#${key}`, action })
    }
  }

  if (collisions.length > 0) {
    for (const sym of registeredSyms) {
      const route = ctx.handlers.get(sym)
      if (route) {
        removeRoute(ctx.router, route.setting.method, prefix + route.setting.path)
        ctx.handlers.delete(sym)
      }
    }

    return yield* fail(
      CoreErrors.Exists,
      `already mounted: ${collisions.join(', ')}`,
      `mount "${prefix}"`,
    )
  }

  ctx.compiled = compileRouter(ctx.router, { normalize: true })
  rebuildClaims(ctx)

  yield* ensure(function* () {
    for (const sym of registeredSyms) {
      const route = ctx.handlers.get(sym)
      if (route) {
        removeRoute(ctx.router, route.setting.method, prefix + route.setting.path)
        ctx.handlers.delete(sym)
      }
    }
    ctx.compiled = compileRouter(ctx.router, { normalize: true })
    rebuildClaims(ctx)
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
  rebuildClaims(ctx)
})
