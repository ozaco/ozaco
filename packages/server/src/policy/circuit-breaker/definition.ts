import type { PolicyDef } from 'server:core'
import { CoreErrors, findPolicySetting, makePolicySetting, Policy } from 'server:core'
import { ensure, operation, useContext } from 'std:effect'
import { asFailure, fail } from 'std:result'

import { CircuitBreakerPolicyKey } from './types'
import type { CircuitBreaker } from './types'
import { getOrCreate, getSelf, onFailure, onSuccess, resolveConfig, tryAdmit } from './utils'

export const CircuitBreakerPolicy = Policy.implement({
  name: 'server/policy-circuit-breaker',
  version: '0.0.0',
  *setup(options?: CircuitBreaker.Options) {
    const context: CircuitBreaker.Context = {
      name: options?.name ?? 'policy/circuit-breaker',
      priority: options?.priority ?? 40,
      threshold: options?.threshold ?? 5,
      resetTimeout: options?.resetTimeout ?? 30_000,
      halfOpenMax: options?.halfOpenMax ?? 1,
      entries: new Map(),
      ...(options?.isFailure === undefined ? {} : { isFailure: options.isFailure }),
    }

    yield* Policy.actions.register(getSelf(), context)
    yield* ensure(function* () {
      context.entries.clear()
      yield* Policy.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  config: operation(function* (options?: Partial<CircuitBreaker.Options>) {
    return makePolicySetting<CircuitBreaker.Options>(CircuitBreakerPolicyKey, {
      value: options ?? {},
    })
  }),
  disable: operation(function* () {
    return makePolicySetting<CircuitBreaker.Options>(CircuitBreakerPolicyKey, { disabled: true })
  }),
  apply: operation(function* <T>(dispatchCtx: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
    const setting = yield* findPolicySetting<CircuitBreaker.Options>(
      dispatchCtx,
      CircuitBreakerPolicyKey,
    )
    if (setting?.disabled) {
      return yield* next()
    }
    const override = setting?.value

    const ctx = (yield* useContext(getSelf())) as CircuitBreaker.Context
    const cfg = resolveConfig(ctx, override)
    const isFailurePred = override?.isFailure ?? ctx.isFailure
    const entry = getOrCreate(ctx, `${dispatchCtx.serviceName}\u0000${dispatchCtx.actionKey}`)

    if (!tryAdmit(cfg, entry)) {
      return yield* fail(
        CoreErrors.CircuitOpen,
        `circuit open for ${dispatchCtx.serviceName}.${dispatchCtx.actionKey}`,
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
  }),
})
