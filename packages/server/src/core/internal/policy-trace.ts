import type { Operation } from 'std:effect'
import { Logger } from 'std:logger'

import { OtelAttrs, OtelSpanKind, OtelSpanStatusCode } from '../const'
import { Tracer } from '../definitions'
import type { PolicyDef } from '../types/policy'
import { TraceContext } from '../utils/context'

import { withSpan } from './span'

export interface TracedApply {
  /** the policy's setting key */
  key: string
  /** the policy's context name (display label) */
  name: string
  priority: number
  dispatch: PolicyDef.DispatchContext
  /** whether the policy is disabled for this action (apply is skipped, next runs directly) */
  disabled: boolean
  /** the inner dispatch (used for the disabled passthrough) */
  next: PolicyDef.Next<unknown>
  /** the policy behaviour, given a (counting) next; only invoked when not disabled */
  apply: (next: PolicyDef.Next<unknown>) => Operation<unknown, unknown>
}

/**
 * Instrument a single policy layer for one dispatch: emit an OTel child span (nested under the
 * call span via TraceContext) and, when a logger is installed, a structured debug line. The number
 * of times the layer calls `next` is recorded so the trace distinguishes a short-circuit (0),
 * a normal pass-through (1) and a retry (>1). Only used when `dispatch.trace` is enabled.
 */
export const tracePolicyApply = function* (a: TracedApply): Operation<unknown, unknown> {
  const startedAt = performance.now()
  const hasLogger = (yield* Logger.context.get()) !== undefined

  const span = yield* Tracer.actions.startSpan(a.name, {
    kind: OtelSpanKind.INTERNAL,
    attributes: {
      'policy.name': a.name,
      'policy.key': a.key,
      'policy.priority': a.priority,
      [OtelAttrs.RPC_SERVICE]: a.dispatch.serviceName,
      [OtelAttrs.RPC_METHOD]: a.dispatch.actionKey,
    },
  })
  const spanCtx = yield* span.spanContext()

  let calls = 0
  const countingNext: PolicyDef.Next<unknown> = function* () {
    calls++
    return yield* a.next()
  }

  return yield* withSpan(
    span,
    function* () {
      const value = yield* TraceContext.with(spanCtx, () =>
        a.disabled ? countingNext() : a.apply(countingNext),
      )

      const decision = a.disabled
        ? 'disabled'
        : calls === 0
          ? 'short-circuit'
          : calls > 1
            ? 'retried'
            : 'applied'

      yield* span.setAttributes({ 'policy.decision': decision, 'policy.next.calls': calls })
      yield* span.setStatus({ code: OtelSpanStatusCode.OK })

      if (hasLogger) {
        yield* Logger.actions.debug('policy', {
          policy: a.name,
          key: a.dispatch.key,
          decision,
          calls,
          durationMs: Math.round(performance.now() - startedAt),
        })
      }

      return value
    },
    function* () {
      if (hasLogger) {
        yield* Logger.actions.debug('policy', {
          policy: a.name,
          key: a.dispatch.key,
          decision: 'failed',
          calls,
          durationMs: Math.round(performance.now() - startedAt),
        })
      }
    },
  )
}
