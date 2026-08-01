import type { Response } from 'server:core'
import {
  ActionRequestContext,
  definePolicy,
  PolicyPriority,
  TraceContext,
  untagged,
  valuesOf,
} from 'server:core'
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
    // The dispatch runs inside the request scope, so the envelope and span are readable right here —
    // an exporter can stamp requestId/clientId/userId without re-deriving them. The span rides
    // `req.contexts` (set on every dispatch); TraceContext is only planted when tracing is ON.
    const request = yield* ActionRequestContext.get()
    const trace = dispatch.req.contexts?.trace ?? (yield* TraceContext.get())
    const event = {
      serviceName: dispatch.serviceName,
      actionKey: dispatch.actionKey,
      startedAt,
      ...(request === undefined ? {} : { request }),
      ...(trace === undefined ? {} : { trace }),
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
