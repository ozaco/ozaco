import type { PolicyDef } from 'server:core'
import { findPolicySetting, makePolicySetting, Policy } from 'server:core'
import { ensure, operation, useContext } from 'std:effect'
import { asFailure } from 'std:result'

import { MetricsPolicyKey } from './types'
import type { Metrics } from './types'
import { getSelf, runHook } from './utils'

export const MetricsPolicy = Policy.implement({
  name: 'server/policy-metrics',
  version: '0.0.0',
  *setup(options?: Metrics.Options) {
    const context: Metrics.Context = {
      name: options?.name ?? 'policy/metrics',
      priority: options?.priority ?? 50,
      ...(options?.onCall === undefined ? {} : { onCall: options.onCall }),
      ...(options?.onSuccess === undefined ? {} : { onSuccess: options.onSuccess }),
      ...(options?.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    }

    yield* Policy.actions.register(getSelf(), context)
    yield* ensure(function* () {
      yield* Policy.actions.unregister(getSelf())
    })

    return context
  },
}).build({
  config: operation(function* (options?: Partial<Metrics.Options>) {
    return makePolicySetting<Metrics.Options>(MetricsPolicyKey, { value: options ?? {} })
  }),
  disable: operation(function* () {
    return makePolicySetting<Metrics.Options>(MetricsPolicyKey, { disabled: true })
  }),
  apply: operation(function* <T>(dispatchCtx: PolicyDef.DispatchContext, next: PolicyDef.Next<T>) {
    const setting = yield* findPolicySetting<Metrics.Options>(dispatchCtx, MetricsPolicyKey)
    if (setting?.disabled) {
      return yield* next()
    }
    const override = setting?.value

    const ctx = (yield* useContext(getSelf())) as Metrics.Context
    const onCall = override?.onCall ?? ctx.onCall
    const onSuccess = override?.onSuccess ?? ctx.onSuccess
    const onFailure = override?.onFailure ?? ctx.onFailure

    const startedAt = Date.now()
    const base = {
      serviceName: dispatchCtx.serviceName,
      actionKey: dispatchCtx.actionKey,
      startedAt,
    }

    runHook(() => onCall?.(base))

    try {
      const value = yield* next()
      // run the success hook inside the try but isolated via runHook, so a throwing exporter
      // can never be re-caught below and mislabel a successful dispatch as a failure
      runHook(() => onSuccess?.({ ...base, durationMs: Date.now() - startedAt, value }))
      return value
    } catch (error) {
      const failure = asFailure(error)
      runHook(() => onFailure?.({ ...base, durationMs: Date.now() - startedAt, failure }))
      throw error
    }
  }),
})
