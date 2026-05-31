import { CoreErrors, definePolicy, PolicyPriority } from 'server:core'
import { asFailure, fail } from 'std:result'

import type { CircuitBreaker } from './types'
import { CircuitBreakerPolicyKey } from './types'
import { getOrCreate, onFailure, onSuccess, resolveConfig, tryAdmit } from './utils'

export const CircuitBreakerPolicy = definePolicy<CircuitBreaker.Options, CircuitBreaker.Context>({
  key: CircuitBreakerPolicyKey,
  name: 'server/policy-circuit-breaker',
  contextName: 'policy/circuit-breaker',
  priority: PolicyPriority.CircuitBreaker,
  *setup(options, base) {
    return {
      ...base,
      threshold: options?.threshold ?? 5,
      resetTimeout: options?.resetTimeout ?? 30_000,
      halfOpenMax: options?.halfOpenMax ?? 1,
      entries: new Map(),
      ...(options?.isFailure === undefined ? {} : { isFailure: options.isFailure }),
    }
  },
  teardown: ctx => ctx.entries.clear(),
  *apply({ dispatch, ctx, override, next }) {
    const cfg = resolveConfig(ctx, override)
    const isFailurePred = override?.isFailure ?? ctx.isFailure
    const entry = getOrCreate(ctx, `${dispatch.serviceName}\u0000${dispatch.actionKey}`)

    if (!tryAdmit(cfg, entry)) {
      return yield* fail(
        CoreErrors.CircuitOpen,
        `circuit open for ${dispatch.serviceName}.${dispatch.actionKey}`,
      )
    }

    // whether this call consumed a half-open probe slot (tryAdmit incremented halfOpenInflight)
    const tookProbeSlot = entry.state === 'half-open'

    try {
      const value = yield* next()
      onSuccess(entry)
      return value
    } catch (error) {
      const failure = asFailure(error)
      if (!isFailurePred || isFailurePred(failure)) {
        onFailure(cfg, entry)
      } else if (tookProbeSlot) {
        // a failure the predicate excludes still frees the probe slot it consumed
        entry.halfOpenInflight = Math.max(0, entry.halfOpenInflight - 1)
      }
      throw failure
    }
  },
})
