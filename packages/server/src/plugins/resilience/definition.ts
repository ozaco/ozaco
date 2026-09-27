import type { ServerDef } from 'server:core'
import { Server, ServerErrors } from 'server:core'
import { dispatchSpan } from 'server:internal'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import pkg from '../../../package.json'

import {
  options,
  primary,
  withBreaker,
  withBulkhead,
  withRateLimit,
  withRetry,
  withSingleflight,
  withTimeout,
} from './internal'
import type { ResilienceDef } from './types'

/**
 * Resilience as action options: `timeoutMs`, `retry`, `breaker`, `bulkhead`, `singleflight`,
 * `rateLimit` (cluster-wide through the installed `Kv`, in-memory otherwise) and `fallback`.
 * Layered outermost → innermost: fallback › rateLimit › singleflight › bulkhead › breaker › retry
 * › timeout › handler.
 *
 * Telemetry (scope `@ozaco/server/resilience`), on the DISPATCH span (`dispatchSpan()` — never a
 * plugin span wrapping the chain, such as a cache span): `ozaco.resilience.timeout_ms`, `ozaco.resilience.rate_limit.remaining`,
 * `ozaco.resilience.singleflight` (`leader` | `follower`, a follower LINKS the leader), and
 * `ozaco.resilience.fallback = true` when the fallback answered. A retried attempt 1 is recorded
 * handled (WARN) inline; attempts ≥ 2 and a fallback's primary path are `resilience.attempt`
 * spans; a queued bulkhead call waits in `resilience.bulkhead.wait`; a circuit's state changes
 * are `ozaco.breaker` events and its fail-fast rejections LINK the call that tripped it.
 */
export const Resilience = definePlugin<ServerDef.PluginContext, []>({
  name: 'server-resilience',
  version: pkg.version,
  description:
    'Timeouts, retries, circuit breakers, bulkheads, singleflight, rate limits, fallbacks',

  *setup() {
    if (!(yield* Server.context.get())) {
      return yield* fail(ServerErrors.Configuration, 'Resilience must be installed by createServer')
    }
    const state: ResilienceDef.State = {
      breakers: new Map(),
      bulkheads: new Map(),
      inflight: new Map(),
      counters: new Map(),
    }
    return {
      options,
      hooks: {
        name: 'resilience',
        *dispatch(call, ctx, next) {
          const given = ctx.meta.options as ResilienceDef.Options
          // dispatch-level telemetry lands on the dispatch span even under an outer plugin's
          // span (a Cache installed before this plugin wraps the chain in its own)
          const span = yield* dispatchSpan()
          const step = (inner: ResilienceDef.Next): ResilienceDef.Step => ({
            state,
            call,
            ctx,
            span,
            next: inner,
          })
          let chain: ResilienceDef.Next = () => next(call, ctx)
          if (given.timeoutMs !== undefined) {
            const inner = chain
            const ms = given.timeoutMs
            span.setAttribute('ozaco.resilience.timeout_ms', ms)
            chain = () => withTimeout(ms, call, inner)
          }
          if (given.retry) {
            const inner = chain
            const retry = given.retry
            chain = () => withRetry(retry, step(inner))
          }
          if (given.breaker) {
            const inner = chain
            const breaker = given.breaker
            chain = () => withBreaker(breaker, step(inner))
          }
          if (given.bulkhead) {
            const inner = chain
            const bulkhead = given.bulkhead
            chain = () => withBulkhead(bulkhead, step(inner))
          }
          if (given.singleflight) {
            const inner = chain
            chain = () => withSingleflight(step(inner))
          }
          if (given.rateLimit) {
            const inner = chain
            const limit = given.rateLimit
            chain = () => withRateLimit(limit, step(inner))
          }
          if (given.fallback) {
            const inner = chain
            const fallback = given.fallback
            chain = function* () {
              const outcome = yield* primary({ call, ctx, next: inner })
              if (!isFailure(outcome)) {
                return outcome.value
              }
              // flagged once the fallback ANSWERED — one that fails leaves the call failed
              const answer = yield* fallback(outcome, call, ctx)
              span.setAttribute('ozaco.resilience.fallback', true)
              return answer
            }
          }
          return yield* chain()
        },
      },
    }
  },
}).build()
