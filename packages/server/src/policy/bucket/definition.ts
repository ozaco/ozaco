import { definePolicy, PolicyPriority } from 'server:core'
import { withResolvers } from 'std:effect'
import { asFailure } from 'std:result'

import type { Bucket } from './types'
import { BucketPolicyKey } from './types'
import { scheduleCleanup, tearDown } from './utils'

export const BucketPolicy = definePolicy<Bucket.Options, Bucket.Context>({
  key: BucketPolicyKey,
  name: 'server/policy-bucket',
  contextName: 'policy/bucket',
  priority: PolicyPriority.Bucket,
  *setup(options, base) {
    return {
      ...base,
      interval: options?.interval ?? 20,
      max: options?.max ?? 100,
      vary: options?.vary ?? 'principal',
      entries: new Map(),
    }
  },
  teardown: tearDown,
  *apply({ dispatch, ctx, override, next }) {
    if (dispatch.isStreaming) {
      return yield* next()
    }

    const max = override?.max ?? ctx.max
    const vary = override?.vary ?? ctx.vary
    const key = vary === 'none' ? dispatch.key : `${dispatch.key}\u0000${dispatch.principal}`

    // a concurrent identical request that is still within the batch joins the in-flight dispatch;
    // it re-throws a shared failure inside its OWN coroutine so its own outer policies see it
    const existing = ctx.entries.get(key)
    if (existing && existing.count < max) {
      existing.count++
      const outcome = yield* existing.resolvers.operation
      if (outcome.ok) {
        return outcome.value
      }
      yield* outcome.failure
    }

    if (existing) {
      return yield* next()
    }

    // the first caller of a batch runs the dispatch INLINE in its own scope — so a failure (or a
    // sub-task it spawns) propagates normally to the outer policies and the caller — and shares
    // the outcome with the joiners above through the resolvers. (Running it detached on the policy
    // scope instead would escalate failures past those outer policies.)
    const resolvers = withResolvers<Bucket.Outcome>('policy:bucket')
    const entry: Bucket.Entry = { count: 1, resolvers }
    ctx.entries.set(key, entry)
    const cleanup = {
      key,
      entry,
      ...(override?.interval === undefined ? {} : { interval: override.interval }),
    }

    try {
      const value = yield* next()
      resolvers.resolve({ ok: true, value })
      scheduleCleanup(ctx, cleanup)
      return value
    } catch (error) {
      const failure = asFailure(error)
      resolvers.resolve({ ok: false, failure })
      scheduleCleanup(ctx, cleanup)
      yield* failure
    }
  },
})
