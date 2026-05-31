import { Broker, DefaultBroker, describePolicyChain } from 'server:core'
import type { Operation } from 'std:effect'
import { all } from 'std:effect'
import { Logger } from 'std:logger'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { BucketPolicy } from 'server:policy/bucket'
import { BulkPolicy } from 'server:policy/bulk'
import { CachePolicy } from 'server:policy/cache'
import { CircuitBreakerPolicy } from 'server:policy/circuit-breaker'
import { FallbackPolicy } from 'server:policy/fallback'
import { MetricsPolicy } from 'server:policy/metrics'
import { RetryPolicy } from 'server:policy/retry'
import { TimeoutPolicy } from 'server:policy/timeout'

import { ResilientService } from './services/resilient'

/**
 * A self-contained tour of the resilience policies. Run with `SERVICE=resilient`. With the broker's
 * `trace: true` option and a debug-level logger, every dispatch logs one line per policy layer
 * (decision + next-call count); the policies also emit nested OTel spans.
 */
export const runResilienceDemo = function* (): Operation<void, unknown> {
  // a throwaway sink so the metrics policy has something to report at the end
  const metrics = { calls: 0, ok: 0, failed: 0 }

  yield* install(DefaultBroker, { trace: true })

  // the full resilience stack — describePolicyChain() below prints the resolved onion order
  yield* install(CachePolicy, { ttl: 5000 })
  yield* install(FallbackPolicy)
  yield* install(BucketPolicy, { interval: 50, max: 100 })
  yield* install(BulkPolicy, { maxConcurrent: 50, maxQueue: 100 })
  yield* install(RetryPolicy, { attempts: 3, delay: 50, backoff: 2 })
  yield* install(CircuitBreakerPolicy, { threshold: 5, resetTimeout: 10_000 })
  yield* install(MetricsPolicy, {
    onCall: () => {
      metrics.calls++
    },
    onSuccess: () => {
      metrics.ok++
    },
    onFailure: () => {
      metrics.failed++
    },
  })
  yield* install(TimeoutPolicy, { timeoutMs: 5000 })

  yield* install(ResilientService)
  yield* Broker.actions.register(ResilientService)
  yield* Broker.actions.start()

  const chain = yield* describePolicyChain()
  yield* Logger.actions.info(
    'Policy chain (outer → inner):',
    chain.map(p => `${p.name}(${p.priority})`).join(' → '),
  )

  // retry: fails twice then recovers within its per-action 5-attempt budget
  const flaky = yield* Broker.actions.call(ResilientService.actions.flaky, [])
  yield* Logger.actions.info('flaky →', flaky)

  // cache: the second identical call is served without recomputing
  const miss = yield* Broker.actions.call(ResilientService.actions.expensive, ['report'])
  yield* Logger.actions.info('expensive (miss) →', miss)
  const hit = yield* Broker.actions.call(ResilientService.actions.expensive, ['report'])
  yield* Logger.actions.info('expensive (cache hit) →', hit)

  // fallback: the action always fails but degrades to a static value
  const fragile = yield* Broker.actions.call(ResilientService.actions.fragile, [])
  yield* Logger.actions.info('fragile (fallback) →', fragile)

  // cache disabled per-action: both calls are fresh
  const a = yield* Broker.actions.call(ResilientService.actions.realtime, [])
  const b = yield* Broker.actions.call(ResilientService.actions.realtime, [])
  yield* Logger.actions.info('realtime (uncached) →', a, b)

  // bucket: three concurrent identical in-flight calls coalesce into ONE dispatch (trace shows the
  // joiners as policy/bucket short-circuits) — all three get the same value
  const burst = yield* all([
    Broker.actions.call(ResilientService.actions.expensive, ['burst']),
    Broker.actions.call(ResilientService.actions.expensive, ['burst']),
    Broker.actions.call(ResilientService.actions.expensive, ['burst']),
  ])
  yield* Logger.actions.info('bucket coalesced burst →', burst.join(', '))

  // timeout: 500ms work exceeds the per-action 200ms budget and surfaces as a failure
  try {
    yield* Broker.actions.call(ResilientService.actions.slow, [500])
  } catch (error) {
    yield* Logger.actions.warn(
      'slow timed out (expected, 200ms budget) →',
      isFailure(error) ? String(error.error) : String(error),
    )
  }

  yield* Logger.actions.info('metrics:', metrics)
}
