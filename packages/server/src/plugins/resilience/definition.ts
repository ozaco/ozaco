import type { ServerDef } from 'server:core'
import { Server, ServerErrors } from 'server:core'
import { attempt } from 'std:effect'
import { definePlugin } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import pkg from '../../../package.json'

import {
  options,
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
          let chain: ResilienceDef.Next = () => next(call, ctx)
          if (given.timeoutMs !== undefined) {
            const inner = chain
            chain = () => withTimeout(given.timeoutMs!, call, inner)
          }
          if (given.retry) {
            const inner = chain
            chain = () => withRetry(given.retry!, inner)
          }
          if (given.breaker) {
            const inner = chain
            chain = () => withBreaker(given.breaker!, { state, call, ctx, next: inner })
          }
          if (given.bulkhead) {
            const inner = chain
            chain = () => withBulkhead(given.bulkhead!, { state, call, ctx, next: inner })
          }
          if (given.singleflight) {
            const inner = chain
            chain = () => withSingleflight({ state, call, ctx, next: inner })
          }
          if (given.rateLimit) {
            const inner = chain
            chain = () => withRateLimit(given.rateLimit!, { state, call, ctx, next: inner })
          }
          if (given.fallback) {
            const inner = chain
            const fallback = given.fallback
            chain = function* () {
              const outcome = yield* attempt(inner)
              if (isFailure(outcome)) {
                return yield* fallback(outcome, call, ctx)
              }
              return outcome.value
            }
          }
          return yield* chain()
        },
      },
    }
  },
}).build()
