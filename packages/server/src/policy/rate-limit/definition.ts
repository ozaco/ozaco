import { CoreErrors, definePolicy, PolicyPriority } from 'server:core'
import { createTokenBucket } from 'server:utils'
import { fail } from 'std:result'

import type { RateLimitOptions, RateLimitOverride, RateLimitState } from './types'

const overrideOf = (override: object | boolean | undefined): RateLimitOverride | undefined =>
  typeof override === 'object' ? (override as RateLimitOverride) : undefined

/** Action identity: the first two `\0` segments of the dispatch key (`service\0action`). */
const actionKeyOf = (key: string): string => {
  const separator = key.indexOf('\0', key.indexOf('\0') + 1)

  return separator === -1 ? key : key.slice(0, separator)
}

/**
 * The rate-limit layer (`PolicyPriority.rateLimit`): a lazily-refilled token bucket per limit key
 * (`service\0action`, plus the principal by default). An exhausted bucket raises
 * `CoreErrors.RateLimited` — HTTP 429 through `CoreStatusMap`. The bucket is created with the
 * options in effect on its first dispatch; later overrides do not resize an existing bucket.
 */
export const RateLimitPolicy = definePolicy<RateLimitOptions, RateLimitState>({
  name: 'rate-limit',
  priority: PolicyPriority.rateLimit,
  *setup(options) {
    return {
      buckets: new Map(),
      capacity: options.capacity,
      refillPerSecond: options.refillPerSecond,
      vary: options.vary ?? 'principal',
    }
  },
  *apply({ ctx, state, override, next }) {
    const tuned = overrideOf(override)
    const capacity = tuned?.capacity ?? state.capacity
    const refillPerSecond = tuned?.refillPerSecond ?? state.refillPerSecond
    const vary = tuned?.vary ?? state.vary
    const actionKey = actionKeyOf(ctx.key)
    const key = vary === 'principal' ? `${actionKey}\0${ctx.principal ?? ''}` : actionKey

    let bucket = state.buckets.get(key)

    if (!bucket) {
      bucket = createTokenBucket({ capacity, refillPerSecond })
      state.buckets.set(key, bucket)
    }

    if (!bucket.take()) {
      return yield* fail(
        CoreErrors.RateLimited,
        `rate limit exceeded for ${ctx.request.service}.${ctx.request.action}`,
        'policy:rate-limit',
      )
    }

    return yield* next()
  },
})
