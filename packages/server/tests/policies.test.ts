import { describe, expect, it } from 'bun:test'

import {
  Broker,
  CoreErrors,
  DefaultBroker,
  defineAction,
  defineService,
  tagOf,
} from '@ozaco/server/core'
import { BucketPolicy } from '@ozaco/server/policy/bucket'
import { BulkPolicy } from '@ozaco/server/policy/bulk'
import { CachePolicy } from '@ozaco/server/policy/cache'
import { CircuitBreakerPolicy } from '@ozaco/server/policy/circuit-breaker'
import { FallbackPolicy } from '@ozaco/server/policy/fallback'
import { MetricsPolicy } from '@ozaco/server/policy/metrics'
import { RetryPolicy } from '@ozaco/server/policy/retry'
import { TimeoutPolicy } from '@ozaco/server/policy/timeout'
import type { Operation } from '@ozaco/std/effect'
import { all, run, sleep } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import { fail, isFailure, isSuccess } from '@ozaco/std/result'

import { call } from './helpers'

type Action = ReturnType<typeof defineAction>

const buildService = <T extends Record<string, Action>>(actions: T) =>
  defineService({
    name: `test-${Math.random().toString(36).slice(2, 10)}`,
    version: '0.0.0',
    actions,
    *setup() {},
  })

const withBroker = function* <T>(
  installs: ReadonlyArray<() => Operation<unknown>>,
  body: () => Operation<T>,
): Operation<T> {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.silent })
  yield* install(DefaultBroker)
  for (const op of installs) {
    yield* op()
  }
  yield* Broker.actions.start()
  return yield* body()
}

describe('BucketPolicy', () => {
  it('coalesces identical in-flight non-stream requests', async () => {
    let dispatchCount = 0
    const service = buildService({
      slow: defineAction(function* (n: number) {
        dispatchCount++
        yield* sleep(50)
        return n * 2
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(BucketPolicy, { interval: 100, max: 100 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* all([
            call(service, 'slow', 21),
            call(service, 'slow', 21),
            call(service, 'slow', 21),
            call(service, 'slow', 21),
            call(service, 'slow', 21),
          ])
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual([42, 42, 42, 42, 42])
    }
    expect(dispatchCount).toBe(1)
  })

  it('does NOT coalesce past max — the overflow passes straight through', async () => {
    let dispatchCount = 0
    const service = buildService({
      slow: defineAction(function* () {
        dispatchCount++
        yield* sleep(40)
        return 'r'
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(BucketPolicy, { interval: 100, max: 2 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* all([
            call(service, 'slow'),
            call(service, 'slow'),
            call(service, 'slow'),
            call(service, 'slow'),
          ])
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    // max=2 — the first bucket coalesces 2 calls; everything past it passes STRAIGHT THROUGH
    // rather than opening a fresh bucket, so calls 3 and 4 dispatch on their own → 3 total.
    // That changed deliberately in 3b1fe3a ("fix: bucket keys, malformed tokens, worker hang"),
    // which added the `if (existing) return next()` branch; the tests of the day were deleted
    // rather than updated, so this expectation had been carrying the pre-fix semantics.
    expect(dispatchCount).toBe(3)
  })

  it('different params do not coalesce', async () => {
    let dispatchCount = 0
    const service = buildService({
      slow: defineAction(function* (n: number) {
        dispatchCount++
        yield* sleep(30)
        return n
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(BucketPolicy, { interval: 100 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* all([
            call(service, 'slow', 1),
            call(service, 'slow', 2),
            call(service, 'slow', 3),
          ])
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual([1, 2, 3])
    }
    expect(dispatchCount).toBe(3)
  })

  it('per-action disable bypasses coalescing', async () => {
    let dispatchCount = 0
    const service = buildService({
      uncoalesced: defineAction({ settings: [BucketPolicy.actions.disable()] }, function* (n) {
        dispatchCount++
        yield* sleep(30)
        return n
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(BucketPolicy, { interval: 1000, max: 100 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* all([
            call(service, 'uncoalesced', 1),
            call(service, 'uncoalesced', 1),
            call(service, 'uncoalesced', 1),
          ])
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(dispatchCount).toBe(3)
  })

  it('stream calls pass through untouched', async () => {
    const service = buildService({
      ping: defineAction(function* (n: number) {
        return n
      }),
    })

    const result = await run(() =>
      withBroker([() => service.actions.install(), () => install(BucketPolicy)], function* () {
        yield* Broker.actions.register(service)
        return yield* call(service, 'ping', 7)
      }),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe(7)
    }
  })
})

describe('RetryPolicy', () => {
  it('retries until success', async () => {
    let attempts = 0
    const service = buildService({
      flaky: defineAction(function* () {
        attempts++
        if (attempts < 3) {
          return yield* fail('transient', `attempt ${attempts}`)
        }
        return 'ok'
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(RetryPolicy, { attempts: 5, delay: 1 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'flaky')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('ok')
    }
    expect(attempts).toBe(3)
  })

  it('attempts=1 means no retry', async () => {
    let attempts = 0
    const service = buildService({
      bad: defineAction(function* () {
        attempts++
        return yield* fail('always', 'nope')
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(RetryPolicy, { attempts: 1 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'bad')
        },
      ),
    )

    expect(isFailure(result)).toBe(true)
    expect(attempts).toBe(1)
  })

  it('exhausts attempts then surfaces final failure', async () => {
    let attempts = 0
    const service = buildService({
      bad: defineAction(function* () {
        attempts++
        return yield* fail('always', 'nope')
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(RetryPolicy, { attempts: 3, delay: 1 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'bad')
        },
      ),
    )

    expect(isFailure(result)).toBe(true)
    expect(attempts).toBe(3)
  })

  it('when() predicate skips retry for non-matching failures', async () => {
    let attempts = 0
    const service = buildService({
      bad: defineAction(function* () {
        attempts++
        return yield* fail('fatal', 'nope')
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(RetryPolicy, {
              attempts: 10,
              delay: 1,
              when: failure => failure.error === 'transient',
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'bad')
        },
      ),
    )

    expect(isFailure(result)).toBe(true)
    expect(attempts).toBe(1)
  })

  it('per-action attempts override raises retry budget', async () => {
    let attempts = 0
    const service = buildService({
      flaky: defineAction(
        { settings: [RetryPolicy.actions.config({ attempts: 5 })] },
        function* () {
          attempts++
          if (attempts < 5) {
            return yield* fail('transient', `attempt ${attempts}`)
          }
          return 'ok'
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(RetryPolicy, { attempts: 2, delay: 1 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'flaky')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(attempts).toBe(5)
  })

  it('per-action disable skips retry entirely', async () => {
    let attempts = 0
    const service = buildService({
      bad: defineAction({ settings: [RetryPolicy.actions.disable()] }, function* () {
        attempts++
        return yield* fail('always', 'nope')
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(RetryPolicy, { attempts: 10, delay: 1 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'bad')
        },
      ),
    )

    expect(isFailure(result)).toBe(true)
    expect(attempts).toBe(1)
  })
})

describe('CachePolicy', () => {
  it('serves identical calls from cache within TTL', async () => {
    let dispatchCount = 0
    const service = buildService({
      lookup: defineAction(function* (k: string) {
        dispatchCount++
        return `value-for-${k}`
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 1000 })],
        function* () {
          yield* Broker.actions.register(service)
          const a = yield* call(service, 'lookup', 'x')
          const b = yield* call(service, 'lookup', 'x')
          const c = yield* call(service, 'lookup', 'y')
          return [a, b, c]
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual(['value-for-x', 'value-for-x', 'value-for-y'])
    }
    expect(dispatchCount).toBe(2)
  })

  it('re-dispatches after TTL expires', async () => {
    let dispatchCount = 0
    const service = buildService({
      now: defineAction(function* () {
        dispatchCount++
        return dispatchCount
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 30 })],
        function* () {
          yield* Broker.actions.register(service)
          const a = yield* call(service, 'now')
          yield* sleep(60)
          const b = yield* call(service, 'now')
          return [a, b]
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual([1, 2])
    }
    expect(dispatchCount).toBe(2)
  })

  it('evicts oldest entry when max is reached (FIFO)', async () => {
    let dispatchCount = 0
    const service = buildService({
      lookup: defineAction(function* (k: string) {
        dispatchCount++
        return `v:${k}`
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 60_000, max: 2 })],
        function* () {
          yield* Broker.actions.register(service)
          yield* call(service, 'lookup', 'a') // d=1; cache: [a]
          yield* call(service, 'lookup', 'b') // d=2; cache: [a,b]
          yield* call(service, 'lookup', 'c') // d=3; evict a; cache: [b,c]
          yield* call(service, 'lookup', 'b') // hit
          yield* call(service, 'lookup', 'a') // d=4 (was evicted)
          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(dispatchCount).toBe(4)
  })

  it('shouldCache() predicate bypasses cache when false', async () => {
    let dispatchCount = 0
    const service = buildService({
      get: defineAction(function* (k: string) {
        dispatchCount++
        return `v:${k}`
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(CachePolicy, {
              ttl: 60_000,
              shouldCache: ctx => ctx.actionKey === 'never',
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          yield* call(service, 'get', 'a')
          yield* call(service, 'get', 'a')
          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(dispatchCount).toBe(2)
  })

  it('per-action ttl override beats global', async () => {
    let dispatchCount = 0
    const service = buildService({
      hot: defineAction({ settings: [CachePolicy.actions.config({ ttl: 30 })] }, function* () {
        dispatchCount++
        return dispatchCount
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 60_000 })],
        function* () {
          yield* Broker.actions.register(service)
          const a = yield* call(service, 'hot')
          const b = yield* call(service, 'hot')
          yield* sleep(60)
          const c = yield* call(service, 'hot')
          return [a, b, c]
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual([1, 1, 2])
    }
    expect(dispatchCount).toBe(2)
  })

  it('per-action disable bypasses cache', async () => {
    let dispatchCount = 0
    const service = buildService({
      uncacheable: defineAction({ settings: [CachePolicy.actions.disable()] }, function* () {
        dispatchCount++
        return dispatchCount
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 60_000 })],
        function* () {
          yield* Broker.actions.register(service)
          const a = yield* call(service, 'uncacheable')
          const b = yield* call(service, 'uncacheable')
          return [a, b]
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual([1, 2])
    }
    expect(dispatchCount).toBe(2)
  })
})

describe('CircuitBreakerPolicy', () => {
  it('opens after threshold and fast-fails subsequent calls', async () => {
    let attempts = 0
    const service = buildService({
      down: defineAction(function* () {
        attempts++
        return yield* fail('boom', 'service is down')
      }),
    })

    let circuitOpenError: unknown
    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(CircuitBreakerPolicy, { threshold: 3, resetTimeout: 10_000 }),
        ],
        function* () {
          yield* Broker.actions.register(service)

          for (let i = 0; i < 3; i++) {
            try {
              yield* call(service, 'down')
            } catch {
              // expected to fail
            }
          }

          try {
            yield* call(service, 'down')
          } catch (error) {
            circuitOpenError = error
          }

          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(attempts).toBe(3)
    expect(isFailure(circuitOpenError)).toBe(true)
    if (isFailure(circuitOpenError)) {
      expect(tagOf(circuitOpenError.error)).toBe(CoreErrors.CircuitOpen)
    }
  })

  it('half-open: single success transitions to closed', async () => {
    let attempts = 0
    let succeed = false
    const service = buildService({
      maybe: defineAction(function* () {
        attempts++
        if (succeed) {
          return 'ok'
        }
        return yield* fail('boom', 'down')
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(CircuitBreakerPolicy, {
              threshold: 2,
              resetTimeout: 30,
              halfOpenMax: 1,
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)

          // 2 failures → open
          for (let i = 0; i < 2; i++) {
            try {
              yield* call(service, 'maybe')
            } catch {
              // expected
            }
          }

          // wait for resetTimeout
          yield* sleep(50)

          // now flip the service to succeed; half-open probe should let it through
          succeed = true
          const value = yield* call(service, 'maybe')

          // circuit should be closed now — many more successes pass
          const value2 = yield* call(service, 'maybe')
          return [value, value2]
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual(['ok', 'ok'])
    }
    expect(attempts).toBe(4) // 2 failures + 2 successes
  })

  it('half-open: failure transitions back to open', async () => {
    let attempts = 0
    const service = buildService({
      down: defineAction(function* () {
        attempts++
        return yield* fail('boom', 'down')
      }),
    })

    let secondOpenError: unknown
    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(CircuitBreakerPolicy, {
              threshold: 2,
              resetTimeout: 30,
              halfOpenMax: 1,
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)

          // 2 failures → open
          for (let i = 0; i < 2; i++) {
            try {
              yield* call(service, 'down')
            } catch {
              // expected
            }
          }

          yield* sleep(50)

          // half-open probe — will fail; circuit re-opens
          try {
            yield* call(service, 'down')
          } catch {
            // expected
          }

          // immediate next call should fast-fail (open again)
          try {
            yield* call(service, 'down')
          } catch (error) {
            secondOpenError = error
          }
          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(attempts).toBe(3) // 2 initial fails + 1 half-open probe (also failed)
    expect(isFailure(secondOpenError)).toBe(true)
    if (isFailure(secondOpenError)) {
      expect(tagOf(secondOpenError.error)).toBe(CoreErrors.CircuitOpen)
    }
  })

  it('per-action threshold override opens sooner', async () => {
    let attempts = 0
    const service = buildService({
      sensitive: defineAction(
        { settings: [CircuitBreakerPolicy.actions.config({ threshold: 2 })] },
        function* () {
          attempts++
          return yield* fail('boom', 'down')
        },
      ),
    })

    let circuitOpen = false
    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(CircuitBreakerPolicy, { threshold: 100, resetTimeout: 10_000 }),
        ],
        function* () {
          yield* Broker.actions.register(service)

          for (let i = 0; i < 2; i++) {
            try {
              yield* call(service, 'sensitive')
            } catch {
              // expected
            }
          }
          try {
            yield* call(service, 'sensitive')
          } catch (error) {
            if (isFailure(error) && error.error === CoreErrors.CircuitOpen) {
              circuitOpen = true
            }
          }
          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(attempts).toBe(2)
    expect(circuitOpen).toBe(true)
  })
})

describe('BulkPolicy', () => {
  it('limits concurrency at maxConcurrent', async () => {
    let concurrent = 0
    let peakConcurrent = 0
    const service = buildService({
      slow: defineAction(function* () {
        concurrent++
        peakConcurrent = Math.max(peakConcurrent, concurrent)
        yield* sleep(40)
        concurrent--
        return 'done'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(BulkPolicy, { maxConcurrent: 2, maxQueue: 10 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* all([
            call(service, 'slow'),
            call(service, 'slow'),
            call(service, 'slow'),
            call(service, 'slow'),
            call(service, 'slow'),
          ])
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(peakConcurrent).toBeLessThanOrEqual(2)
  })

  it('rejects with BulkQueueFull when queue is exhausted', async () => {
    const service = buildService({
      slow: defineAction(function* () {
        yield* sleep(50)
        return 'done'
      }),
    })

    let queueFullError: unknown
    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(BulkPolicy, { maxConcurrent: 1, maxQueue: 1 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          try {
            yield* all([call(service, 'slow'), call(service, 'slow'), call(service, 'slow')])
          } catch (error) {
            queueFullError = error
          }
          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(isFailure(queueFullError)).toBe(true)
    if (isFailure(queueFullError)) {
      expect(queueFullError.error).toBe(CoreErrors.BulkQueueFull)
    }
  })

  it('rejects queued waiters with BulkQueueTimeout when wait exceeds timeout', async () => {
    const service = buildService({
      slow: defineAction(function* () {
        yield* sleep(200)
        return 'done'
      }),
    })

    let timeoutError: unknown
    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(BulkPolicy, { maxConcurrent: 1, maxQueue: 5, queueTimeout: 30 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          try {
            yield* all([call(service, 'slow'), call(service, 'slow')])
          } catch (error) {
            timeoutError = error
          }
          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(isFailure(timeoutError)).toBe(true)
    if (isFailure(timeoutError)) {
      expect(timeoutError.error).toBe(CoreErrors.BulkQueueTimeout)
    }
  })

  it('per-action disable bypasses bulkhead', async () => {
    let concurrent = 0
    let peakConcurrent = 0
    const service = buildService({
      uncapped: defineAction({ settings: [BulkPolicy.actions.disable()] }, function* () {
        concurrent++
        peakConcurrent = Math.max(peakConcurrent, concurrent)
        yield* sleep(30)
        concurrent--
        return 'done'
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(BulkPolicy, { maxConcurrent: 1 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* all([
            call(service, 'uncapped'),
            call(service, 'uncapped'),
            call(service, 'uncapped'),
          ])
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(peakConcurrent).toBeGreaterThan(1)
  })
})

describe('TimeoutPolicy', () => {
  it('fails with Timeout when dispatch exceeds deadline', async () => {
    const service = buildService({
      slow: defineAction(function* () {
        yield* sleep(200)
        return 'done'
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(TimeoutPolicy, { timeoutMs: 30 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'slow')
        },
      ),
    )

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(tagOf(result.error)).toBe(CoreErrors.Timeout)
    }
  })

  it('passes through under deadline', async () => {
    const service = buildService({
      fast: defineAction(function* () {
        return 'quick'
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(TimeoutPolicy, { timeoutMs: 500 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'fast')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('quick')
    }
  })

  it('per-action timeoutMs override', async () => {
    const service = buildService({
      slow: defineAction(
        { settings: [TimeoutPolicy.actions.config({ timeoutMs: 10 })] },
        function* () {
          yield* sleep(100)
          return 'done'
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(TimeoutPolicy, { timeoutMs: 10_000 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'slow')
        },
      ),
    )

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(tagOf(result.error)).toBe(CoreErrors.Timeout)
    }
  })

  it('stream calls pass through without timeout', async () => {
    let dispatched = false
    const service = buildService({
      ping: defineAction(function* (n: number) {
        dispatched = true
        return n
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(TimeoutPolicy, { timeoutMs: 5, timeoutStreams: false }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'ping', 9)
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(dispatched).toBe(true)
  })
})

describe('FallbackPolicy', () => {
  it('returns static fallback value on failure', async () => {
    const service = buildService({
      bad: defineAction(
        { settings: [FallbackPolicy.actions.config({ value: 'fallback-val' })] },
        function* (): Operation<string> {
          return yield* fail('boom', 'broken')
        },
      ),
    })

    const result = await run(() =>
      withBroker([() => service.actions.install(), () => install(FallbackPolicy)], function* () {
        yield* Broker.actions.register(service)
        return yield* call(service, 'bad')
      }),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('fallback-val')
    }
  })

  it('handler is invoked on failure and receives the failure', async () => {
    let handlerReceived = false
    const service = buildService({
      bad: defineAction(
        {
          settings: [
            FallbackPolicy.actions.config({
              *handler(failure) {
                handlerReceived = failure.error === 'boom'
                return 'from-handler'
              },
            }),
          ],
        },
        function* (): Operation<string> {
          return yield* fail('boom', 'broken')
        },
      ),
    })

    const result = await run(() =>
      withBroker([() => service.actions.install(), () => install(FallbackPolicy)], function* () {
        yield* Broker.actions.register(service)
        return yield* call(service, 'bad')
      }),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('from-handler')
    }
    expect(handlerReceived).toBe(true)
  })

  it('handler takes precedence over value when both are set', async () => {
    const service = buildService({
      bad: defineAction(
        {
          settings: [
            FallbackPolicy.actions.config({
              value: 'static',
              *handler() {
                return 'dynamic'
              },
            }),
          ],
        },
        function* (): Operation<string> {
          return yield* fail('boom', 'broken')
        },
      ),
    })

    const result = await run(() =>
      withBroker([() => service.actions.install(), () => install(FallbackPolicy)], function* () {
        yield* Broker.actions.register(service)
        return yield* call(service, 'bad')
      }),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('dynamic')
    }
  })

  it('when() returning false lets the original failure propagate', async () => {
    const service = buildService({
      bad: defineAction(
        {
          settings: [
            FallbackPolicy.actions.config({
              value: 'fallback',
              when: failure => failure.error === 'transient',
            }),
          ],
        },
        function* () {
          return yield* fail('fatal', 'unrelated')
        },
      ),
    })

    const result = await run(() =>
      withBroker([() => service.actions.install(), () => install(FallbackPolicy)], function* () {
        yield* Broker.actions.register(service)
        return yield* call(service, 'bad')
      }),
    )

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(tagOf(result.error)).toBe('fatal')
    }
  })

  it('passes through on success', async () => {
    const service = buildService({
      good: defineAction(
        { settings: [FallbackPolicy.actions.config({ value: 'never-used' })] },
        function* () {
          return 'ok'
        },
      ),
    })

    const result = await run(() =>
      withBroker([() => service.actions.install(), () => install(FallbackPolicy)], function* () {
        yield* Broker.actions.register(service)
        return yield* call(service, 'good')
      }),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('ok')
    }
  })
})

describe('MetricsPolicy', () => {
  it('emits onCall + onSuccess on success with positive durationMs', async () => {
    const calls: string[] = []
    let successDuration = -1
    let successValue: unknown
    const service = buildService({
      hello: defineAction(function* (name: string) {
        yield* sleep(5)
        return `hi ${name}`
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(MetricsPolicy, {
              onCall: e => calls.push(`${e.serviceName}.${e.actionKey}`),
              onSuccess: e => {
                successDuration = e.durationMs
                successValue = e.value
              },
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'hello', 'world')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(calls).toHaveLength(1)
    expect(successValue).toBe('hi world')
    expect(successDuration).toBeGreaterThanOrEqual(0)
  })

  it('emits onFailure on failure with original error code', async () => {
    const failures: { error: unknown; durationMs: number }[] = []
    const service = buildService({
      bad: defineAction(function* () {
        return yield* fail('boom', 'broken')
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(MetricsPolicy, {
              onFailure: e => failures.push({ error: e.failure.error, durationMs: e.durationMs }),
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'bad')
        },
      ),
    )

    expect(isFailure(result)).toBe(true)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.error).toBe('boom')
    expect(failures[0]?.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('per-action onSuccess override replaces global', async () => {
    const globalEvents: string[] = []
    const localEvents: string[] = []
    const service = buildService({
      hello: defineAction(
        {
          settings: [
            MetricsPolicy.actions.config({
              onSuccess: e => localEvents.push(`local:${String(e.value)}`),
            }),
          ],
        },
        function* () {
          return 'override-me'
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(MetricsPolicy, {
              onSuccess: e => globalEvents.push(`global:${String(e.value)}`),
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'hello')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(localEvents).toEqual(['local:override-me'])
    expect(globalEvents).toEqual([])
  })
})

describe('policy composition', () => {
  it('cache short-circuits the chain — retry/cb not invoked on hit', async () => {
    let dispatchCount = 0
    let cbHits = 0
    const service = buildService({
      lookup: defineAction(function* (k: string) {
        dispatchCount++
        return `v:${k}`
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(CachePolicy, { ttl: 60_000 }),
          () => install(RetryPolicy, { attempts: 3, delay: 1 }),
          () =>
            install(MetricsPolicy, {
              onCall: () => {
                cbHits++
              },
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          yield* call(service, 'lookup', 'a')
          yield* call(service, 'lookup', 'a')
          yield* call(service, 'lookup', 'a')
          return null
        },
      ),
    )

    if (!isSuccess(result)) {
      console.error('composition-cache:', result)
    }
    expect(isSuccess(result)).toBe(true)
    expect(dispatchCount).toBe(1)
    // metrics is innermost (priority 50) — runs only when chain proceeds to dispatch
    // cache short-circuits subsequent calls before metrics runs
    expect(cbHits).toBe(1)
  })

  it('retry triggers metrics for each attempt', async () => {
    let attempts = 0
    let metricCalls = 0
    let metricFailures = 0
    const service = buildService({
      flaky: defineAction(function* () {
        attempts++
        if (attempts < 3) {
          return yield* fail('transient', `attempt ${attempts}`)
        }
        return 'ok'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(RetryPolicy, { attempts: 5, delay: 1 }),
          () =>
            install(MetricsPolicy, {
              onCall: () => {
                metricCalls++
              },
              onFailure: () => {
                metricFailures++
              },
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'flaky')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(attempts).toBe(3)
    expect(metricCalls).toBe(3) // metrics is inside retry → fires per attempt
    expect(metricFailures).toBe(2)
  })
})
