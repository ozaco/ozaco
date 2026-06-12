import { definePolicy, PolicyPriority } from 'server:core'

import type { Cache } from './types'
import { CachePolicyKey } from './types'
import { evictOldest, tearDown } from './utils'

export const CachePolicy = definePolicy<Cache.Options, Cache.Context>({
  key: CachePolicyKey,
  name: 'server/policy-cache',
  contextName: 'policy/cache',
  priority: PolicyPriority.Cache,
  *setup(options, base) {
    return {
      ...base,
      ttl: options?.ttl ?? 30_000,
      max: options?.max ?? 1000,
      vary: options?.vary ?? 'principal',
      entries: new Map(),
      ...(options?.shouldCache === undefined ? {} : { shouldCache: options.shouldCache }),
    }
  },
  teardown: tearDown,
  *apply({ dispatch, ctx, override, next }) {
    if (dispatch.isStreaming) {
      return yield* next()
    }

    const ttl = override?.ttl ?? ctx.ttl
    const max = override?.max ?? ctx.max
    const shouldCache = override?.shouldCache ?? ctx.shouldCache

    if (shouldCache && !shouldCache(dispatch)) {
      return yield* next()
    }

    const vary = override?.vary ?? ctx.vary
    const key = vary === 'none' ? dispatch.key : `${dispatch.key}\u0000${dispatch.principal}`
    const existing = ctx.entries.get(key)
    if (existing && existing.expiresAt > Date.now()) {
      return existing.value
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
  },
})
