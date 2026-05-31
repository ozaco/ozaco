import { bypass, defineAction, defineService } from 'server:core'
import type { Operation } from 'std:effect'
import { sleep } from 'std:effect'
import { fail } from 'std:result'

import { BucketPolicy } from 'server:policy/bucket'
import { CachePolicy } from 'server:policy/cache'
import { FallbackPolicy } from 'server:policy/fallback'
import { RetryPolicy } from 'server:policy/retry'
import { TimeoutPolicy } from 'server:policy/timeout'
import { z } from 'zod'

// demo-only mutable counters so each action visibly does something different per call
let attempts = 0
let tick = 0

/**
 * A service whose actions opt into specific resilience behaviours via per-action `settings`.
 * Each `Policy.actions.config(...)` / `.disable()` is type-checked against that policy's options.
 */
export const ResilientService = defineService({
  name: 'resilient',
  version: '0.0.0',

  actions: {
    // fails the first two of every three calls — the per-action retry budget recovers it
    flaky: defineAction(
      { settings: [RetryPolicy.actions.config({ attempts: 5, delay: 20 })] },
      function* (): Operation<string, 'transient'> {
        attempts++
        if (attempts % 3 !== 0) {
          return yield* fail('transient', `attempt ${attempts} failed`)
        }
        return `recovered after ${attempts} attempts`
      },
    ),

    // bounded to 200ms regardless of the global timeout
    slow: defineAction(
      {
        input: z.number(),
        settings: [TimeoutPolicy.actions.config({ timeoutMs: 200 })],
      },
      function* (ms) {
        yield* sleep(ms)
        return `slept ${ms}ms`
      },
    ),

    // expensive computation cached for 10s (second identical call is a hit)
    expensive: defineAction(
      {
        input: z.string(),
        settings: [CachePolicy.actions.config({ ttl: 10_000 })],
      },
      function* (key) {
        yield* sleep(50)
        return `computed:${key}`
      },
    ),

    // always fails, but degrades gracefully to a static fallback value
    fragile: defineAction(
      { settings: [FallbackPolicy.actions.config({ value: 'served-from-fallback' })] },
      function* (): Operation<string, 'down'> {
        return yield* fail('down', 'dependency unavailable')
      },
    ),

    // opts OUT of both the cache and the request-coalescing bucket so every call is fresh
    realtime: defineAction({ settings: bypass(CachePolicy, BucketPolicy) }, function* () {
      tick++
      return `tick:${tick}`
    }),
  },

  *setup() {},
})
