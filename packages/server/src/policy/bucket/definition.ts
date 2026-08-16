import { definePolicy, PolicyPriority } from 'server:core'
import type { Reply } from 'server:core'
import { createSingleflight } from 'server:utils'

import type { BucketOptions, BucketOverride, BucketState } from './types'

const overrideOf = (override: object | boolean | undefined): BucketOverride | undefined =>
  typeof override === 'object' ? (override as BucketOverride) : undefined

/**
 * The coalescing layer (`PolicyPriority.bucket`): concurrent dispatches with the same key share
 * ONE execution and ONE {@link Reply}. Failure replies are shared like values; raised failures
 * re-raise in every joiner (single-flight semantics). Streaming dispatches skip the layer unless
 * the action opts in.
 */
export const BucketPolicy = definePolicy<BucketOptions, BucketState>({
  name: 'bucket',
  priority: PolicyPriority.bucket,
  skipStreaming: true,
  *setup(options) {
    return {
      flight: createSingleflight<Reply>(),
      vary: options.vary ?? 'principal',
    }
  },
  *apply({ ctx, state, override, next }) {
    const vary = overrideOf(override)?.vary ?? state.vary
    const key = vary === 'principal' ? `${ctx.key}\0${ctx.principal ?? ''}` : ctx.key

    return yield* state.flight.run(key, next)
  },
})
