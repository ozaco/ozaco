// oxlint-disable import/exports-last
import { CoreErrors, definePolicy, laneOf, PolicyPriority } from 'server:core'
import type { PolicyDispatch, Reply } from 'server:core'
import { attempt, createContext } from 'std:effect'
import type { Context } from 'std:effect'
import { isFailure } from 'std:result'
import type { Result } from 'std:result'

import type { CallEvent, MetricsSink } from './types'

/** Planted by the metrics collector; absent sink = zero-cost passthrough. */
export const MetricsSinkContext: Context<MetricsSink> = createContext<MetricsSink>(
  'server:policy/metrics:sink',
)

const eventOf = (input: {
  readonly ctx: PolicyDispatch
  readonly started: number
  readonly reply?: Reply | undefined
  readonly raised?: Result.Failure<unknown> | undefined
}): CallEvent => {
  const { ctx, started, reply, raised } = input
  const trace = ctx.trace
  const failureReply = reply?.kind === 'failure' ? reply : undefined
  const raisedTag = raised ? String(raised.error) : undefined
  const outcome: CallEvent['outcome'] = raised
    ? raisedTag === CoreErrors.TimeoutPending
      ? 'unknown'
      : raisedTag === CoreErrors.Cancelled
        ? 'cancelled'
        : 'failed'
    : failureReply
      ? 'failed'
      : 'fulfilled'

  return {
    ts: started,
    service: ctx.request.service,
    action: ctx.request.action,
    status: raised || failureReply ? 'failure' : 'success',
    durationMs: Date.now() - started,
    requestId: trace.requestId,
    serviceId: trace.serviceId,
    laneId: laneOf(trace),
    actionId: trace.actionId,
    parentActionId: trace.parentActionId,
    outcome,
    delivered: !raised,
    origin: trace.origin,
    transport: trace.lane.at(-1)?.transport ?? 'internal',
    error: raisedTag ?? failureReply?.failure.error,
    causes: raised
      ? [...raised.causes]
      : failureReply
        ? [...failureReply.failure.causes]
        : undefined,
  }
}

/**
 * The observer layer (priority `PolicyPriority.metrics`): records EVERY dispatch — success and
 * failure alike — with the full correlation spine. The sink is sync and isolated: a throwing sink
 * can never corrupt the dispatch result.
 */
export const MetricsPolicy = definePolicy<void, void>({
  name: 'metrics',
  priority: PolicyPriority.metrics,
  *setup() {},
  *apply({ ctx, next }) {
    const sink = yield* MetricsSinkContext.get()

    if (!sink) {
      return yield* next()
    }

    const started = Date.now()
    const outcome = yield* attempt(() => next())

    if (isFailure(outcome)) {
      try {
        sink.call(eventOf({ ctx, started, raised: outcome }))
      } catch {
        // a broken sink must never affect the dispatch
      }

      return yield* outcome
    }

    try {
      sink.call(eventOf({ ctx, started, reply: outcome.value }))
    } catch {
      // a broken sink must never affect the dispatch
    }

    return outcome.value
  },
})
