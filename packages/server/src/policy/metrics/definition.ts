import type { Response } from 'server:core'
import { definePolicy, PolicyPriority, untagged, valuesOf } from 'server:core'
import { asFailure } from 'std:result'

import type { Metrics } from './types'
import { MetricsPolicyKey } from './types'
import { runHook } from './utils'

export const MetricsPolicy = definePolicy<Metrics.Options, Metrics.Context>({
  key: MetricsPolicyKey,
  name: 'server/policy-metrics',
  contextName: 'policy/metrics',
  priority: PolicyPriority.Metrics,
  *setup(options, base) {
    return {
      ...base,
      ...(options?.onCall === undefined ? {} : { onCall: options.onCall }),
      ...(options?.onSuccess === undefined ? {} : { onSuccess: options.onSuccess }),
      ...(options?.onFailure === undefined ? {} : { onFailure: options.onFailure }),
    }
  },
  *apply({ dispatch, ctx, override, next }) {
    const onCall = override?.onCall ?? ctx.onCall
    const onSuccess = override?.onSuccess ?? ctx.onSuccess
    const onFailure = override?.onFailure ?? ctx.onFailure

    const startedAt = Date.now()
    const event = {
      serviceName: dispatch.serviceName,
      actionKey: dispatch.actionKey,
      startedAt,
    }

    runHook(() => onCall?.(event))

    try {
      const value = yield* next()
      // isolated via runHook so a throwing exporter can never be re-caught and mislabel success
      // The envelope is transport plumbing; an application's observer asked for the answer.
      runHook(() =>
        onSuccess?.({
          ...event,
          durationMs: Date.now() - startedAt,
          value: valuesOf((value as Response).sources)[0],
        }),
      )
      return value
    } catch (error) {
      const failure = asFailure(error)
      // Same reason as the value above: an exporter asked what went wrong, not how core carries it.
      runHook(() =>
        onFailure?.({ ...event, durationMs: Date.now() - startedAt, failure: untagged(failure) }),
      )
      yield* failure
    }
  },
})
