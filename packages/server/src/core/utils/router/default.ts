import { all, operation, useContext } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { addRoute, createRouter, findAllRoutes, removeRoute } from 'rou3'
import { compileRouter } from 'rou3/compiler'
import type { Action, Service } from 'server:service'
import { isAction, isService } from 'server:service'

import { DEFAULT_REST_METHODS } from '../../const'
import type { Helpers } from '../../types/helpers'
import type { RouterContext } from '../../types/router'
import type { RestTransformerOptions } from '../../types/transformer'
import { Rest } from '../transformer/rest'

import { Router } from './definition'

const findRestSettings = (settings: unknown[], transformer: unknown) =>
  settings.find((setting: AnyType) => setting.transformer === transformer) as
    | RestTransformerOptions
    | undefined

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

const mountEntry = operation(function* (ctx: RouterContext, prefix: string, entry: MountEntry) {
  const transformer = ctx.transformer

  if (isDenied(entry.meta, transformer)) {
    return
  }

  const settings = yield* all(entry.meta.settings ?? [])
  const restSettings =
    findRestSettings(settings, transformer) ??
    (entry.fallbackName
      ? (DEFAULT_REST_METHODS[entry.fallbackName as keyof typeof DEFAULT_REST_METHODS] as
          | RestTransformerOptions
          | undefined)
      : undefined)

  if (!restSettings) {
    if (!entry.fallbackName) {
      yield* fail(
        'missing-settings',
        `action "${entry.key}" has no settings for the current transformer`,
      )
    }
    return
  }

  ctx.handlers.set(entry.sym, { handler: entry.handler, key: entry.key, settings: restSettings })
  addRoute(ctx.router, restSettings.method, prefix + restSettings.path, entry.sym)
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
      if (entry.service !== target && entry.handler !== target) {
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
