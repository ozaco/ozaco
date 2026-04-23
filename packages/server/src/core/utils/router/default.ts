import { all, operation, useContext } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { addRoute, createRouter, findAllRoutes, removeRoute } from 'rou3'
import { compileRouter } from 'rou3/compiler'
import type { Action, Service } from 'server:service'
import { isAction, isService } from 'server:service'

import { DEFAULT_REST_METHODS } from '../../const'
import type { Helpers } from '../../types/helpers'
import type { RouterContext } from '../../types/router'
import { Rest } from '../transformer/rest'

import { Router } from './definition'

interface ResolvedSetting {
  method: string
  path: string
  transformer: Helpers.AnyRestTransformer
  [key: string]: AnyType
}

const isDenied = (
  meta: { isRaw?: boolean; allow?: AnyType[]; deny?: AnyType[] },
  transformer: unknown,
): boolean =>
  Boolean(
    meta.isRaw ||
    (meta.allow && !meta.allow.includes(transformer)) ||
    (meta.deny && meta.deny.includes(transformer)),
  )

interface MountEntry {
  meta: { isRaw?: boolean; allow?: AnyType[]; deny?: AnyType[]; settings?: AnyType[] }
  key: string
  handler: AnyType
  sym: symbol
  fallbackName?: string
}

// oxlint-disable-next-line max-params
const mountRoute = (
  ctx: RouterContext,
  prefix: string,
  entry: MountEntry,
  setting: ResolvedSetting,
) => {
  const sym = Symbol(`${entry.sym.description ?? entry.key}:${setting.method}`)
  ctx.handlers.set(sym, {
    handler: entry.handler,
    key: entry.key,
    settings: setting,
  })
  addRoute(ctx.router, setting.method, prefix + setting.path, sym)
}

const mountEntry = operation(function* (ctx: RouterContext, prefix: string, entry: MountEntry) {
  const resolvedSettings = (yield* all(entry.meta.settings ?? [])) as ResolvedSetting[]

  const mountable = resolvedSettings.filter(s => !isDenied(entry.meta, s.transformer))

  if (mountable.length > 0) {
    for (const setting of mountable) {
      mountRoute(ctx, prefix, entry, setting)
    }
    return
  }

  if (entry.fallbackName && !isDenied(entry.meta, Rest)) {
    const fallback = DEFAULT_REST_METHODS[entry.fallbackName as keyof typeof DEFAULT_REST_METHODS]
    if (fallback) {
      mountRoute(ctx, prefix, entry, {
        method: fallback.method,
        path: fallback.path,
        transformer: Rest,
      })
      return
    }
  }

  if (!entry.fallbackName) {
    yield* fail(
      'missing-settings',
      `action "${entry.key}" has no transformer settings and no fallback`,
    )
  }
})

const mountAction = operation(function* (ctx: RouterContext, prefix: string, target: Action) {
  const key = target.title ?? 'anonymous'
  yield* mountEntry(ctx, prefix, {
    meta: target,
    key,
    handler: target,
    sym: Symbol(`action:${key}`),
  })
})

const mountService = operation(function* (ctx: RouterContext, prefix: string, service: Service) {
  for (const key of service.getKeys()) {
    const meta = service.meta.get(key)
    if (!meta) {
      continue
    }

    let handler: AnyType = service.actions
    for (const part of key.split('.')) {
      handler = handler[part]
    }

    yield* mountEntry(ctx, prefix, {
      meta,
      key,
      handler,
      sym: Symbol(`${service.name}:${key}`),
      fallbackName: key.split('.').pop()!,
    })
  }
})

const DefaultRouterDef = Router.implement({
  name: 'default-router',
  version: '0.0.1',

  // oxlint-disable-next-line require-yield
  *setup() {
    const router = createRouter()
    const compiled = compileRouter(router, { normalize: true })

    return {
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

  mount: operation(function* (prefix, target) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    if (isAction(target)) {
      yield* mountAction(ctx, prefix, target)
    } else if (isService(target)) {
      yield* mountService(ctx, prefix, target)
    }

    ctx.compiled = compileRouter(ctx.router, { normalize: true })
  }),

  unmount: operation(function* (target) {
    const ctx = yield* useContext(DefaultRouterDef.context)

    for (const [sym, entry] of ctx.handlers) {
      if ((entry as AnyType).service !== target && entry.handler !== target) {
        continue
      }
      const settings = entry.settings as { method?: string; path?: string } | undefined
      if (settings?.method && settings?.path) {
        removeRoute(ctx.router, settings.method, settings.path)
      }
      ctx.handlers.delete(sym)
    }

    ctx.compiled = compileRouter(ctx.router, { normalize: true })
  }),
})
