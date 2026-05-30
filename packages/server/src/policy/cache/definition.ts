import type { PolicyDef } from 'server:core'
import { findPolicySetting, makePolicySetting, Policy } from 'server:core'
import { ensure, operation, useContext } from 'std:effect'

import { CachePolicyKey } from './types'
import type { Cache } from './types'
import { evictOldest, getSelf, tearDown } from './utils'

export const CachePolicy = Policy.implement({
  name: 'server/policy-cache',
  version: '0.0.0',
  *setup(options?: Cache.Options) {
    const context: Cache.Context = {
      name: options?.name ?? 'policy/cache',
      priority: options?.priority ?? 0,
      ttl: options?.ttl ?? 30_000,
      max: options?.max ?? 1000,
      entries: new Map(),
      ...(options?.shouldCache === undefined ? {} : { shouldCache: options.shouldCache }),
    }

    yield* Policy.actions.register(getSelf(), context)
    yield* ensure(function* () {
      tearDown(context)
      yield* Policy.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  config: operation(function* (options?: Partial<Cache.Options>) {
    return makePolicySetting<Cache.Options>(CachePolicyKey, { value: options ?? {} })
  }),
  disable: operation(function* () {
    return makePolicySetting<Cache.Options>(CachePolicyKey, { disabled: true })
  }),
  apply: operation(function* <T>(dispatchCtx: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
    if (dispatchCtx.isStreaming) {
      return yield* next()
    }

    const setting = yield* findPolicySetting<Cache.Options>(dispatchCtx, CachePolicyKey)
    if (setting?.disabled) {
      return yield* next()
    }
    const override = setting?.value

    const ctx = (yield* useContext(getSelf())) as Cache.Context
    const ttl = override?.ttl ?? ctx.ttl
    const max = override?.max ?? ctx.max
    const shouldCache = override?.shouldCache ?? ctx.shouldCache

    if (shouldCache && !shouldCache(dispatchCtx)) {
      return yield* next()
    }

    const key = dispatchCtx.key
    const existing = ctx.entries.get(key)
    if (existing && existing.expiresAt > Date.now()) {
      return existing.value as T
    }
    if (existing) {
      clearTimeout(existing.timer)
      ctx.entries.delete(key)
    }

    const value = yield* next()

    // a concurrent identical miss may have populated this slot while we awaited next();
    // clear its timer before overwriting so the stale timer can't prematurely evict our entry
    const prior = ctx.entries.get(key)
    if (prior) {
      clearTimeout(prior.timer)
      ctx.entries.delete(key)
    }

    if (ctx.entries.size >= max) {
      evictOldest(ctx)
    }

    const entry: Cache.Entry = {
      value,
      expiresAt: Date.now() + ttl,
      timer: setTimeout(() => {
        ctx.entries.delete(key)
      }, ttl),
    }
    ctx.entries.set(key, entry)

    return value
  }),
})
