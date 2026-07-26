import { describe, expect, it } from 'bun:test'

import {
  Broker,
  CoreErrors,
  DefaultBroker,
  chunks,
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
import type { Result } from '@ozaco/std/result'
import { asFailure, fail, isFailure, isSuccess } from '@ozaco/std/result'
import { z } from 'zod'

import { call } from './helpers'

type AnyAction = ReturnType<typeof defineAction>

const buildService = <T extends Record<string, AnyAction>>(actions: T) =>
  defineService({
    name: `edge-${Math.random().toString(36).slice(2, 10)}`,
    version: '0.0.0',
    actions,
    *setup() {},
  })

const namedService = <T extends Record<string, AnyAction>>(name: string, actions: T) =>
  defineService({ name, version: '0.0.0', actions, *setup() {} })

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

// settle an operation into a tagged outcome without halting siblings or escaping the type system
// (no `box` is exported from std:effect, and `succeed`'s conditional return type does not narrow
// cleanly through a generic generator)
type Settled<T> = { ok: true; value: T } | { ok: false; failure: Result.Failure<unknown> }

const attempt = function* <T>(op: () => Operation<T>): Operation<Settled<T>> {
  try {
    return { ok: true, value: yield* op() }
  } catch (error) {
    return { ok: false, failure: asFailure(error) }
  }
}

describe('CachePolicy (edge)', () => {
  it('shouldCache() returning true caches the result', async () => {
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
          () => install(CachePolicy, { ttl: 60_000, shouldCache: () => true }),
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
    expect(dispatchCount).toBe(1)
  })

  it('caches an undefined return value (hit, no re-dispatch)', async () => {
    let dispatchCount = 0
    const service = buildService({
      nothing: defineAction(function* (): Operation<undefined> {
        dispatchCount++
        return undefined
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 60_000 })],
        function* () {
          yield* Broker.actions.register(service)
          const a = yield* call(service, 'nothing')
          const b = yield* call(service, 'nothing')
          return [a, b]
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual([undefined, undefined])
    }
    expect(dispatchCount).toBe(1)
  })

  it('does not cache failures — a failing call re-dispatches', async () => {
    let dispatchCount = 0
    const service = buildService({
      flaky: defineAction(function* (): Operation<string> {
        dispatchCount++
        if (dispatchCount === 1) {
          return yield* fail('transient', 'first fails')
        }
        return 'ok'
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 60_000 })],
        function* () {
          yield* Broker.actions.register(service)
          const first = yield* attempt(() => call(service, 'flaky'))
          const second = yield* attempt(() => call(service, 'flaky'))
          return { first, second }
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value.first.ok).toBe(false)
      expect(result.value.second.ok).toBe(true)
    }
    expect(dispatchCount).toBe(2)
  })

  it('concurrent identical misses do not truncate the cached TTL (orphan-timer fix)', async () => {
    let dispatchCount = 0
    let order = 0
    const service = buildService({
      slow: defineAction(function* (k: string) {
        dispatchCount++
        // first concurrent miss resolves earlier than the second, so its (earlier) expiry timer
        // would orphan and prematurely evict the second writer's entry without the fix
        yield* sleep(++order === 1 ? 10 : 50)
        return `v:${k}`
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 60 })],
        function* () {
          yield* Broker.actions.register(service)
          // two concurrent identical misses
          yield* all([call(service, 'slow', 'x'), call(service, 'slow', 'x')])
          // probe between the orphaned timer's deadline (10+60=70) and the real one (50+60=110)
          yield* sleep(30)
          yield* call(service, 'slow', 'x')
          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    // 2 concurrent misses dispatch; the probe must be a cache HIT (no third dispatch)
    expect(dispatchCount).toBe(2)
  })

  it('bypasses the cache for streaming calls', async () => {
    let dispatchCount = 0
    const service = buildService({
      // streaming is DECLARED now — an empty `streams: []` option used to be what marked a call
      // streaming, which meant the caller decided, not the action
      get: defineAction({ input: z.string(), output: chunks() }, function* (k: string) {
        dispatchCount++
        return `v:${k}` as never
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 60_000 })],
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
})

describe('RetryPolicy (edge)', () => {
  it('when() matching the failure retries until success', async () => {
    let attempts = 0
    const service = buildService({
      flaky: defineAction(function* (): Operation<string> {
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
          () =>
            install(RetryPolicy, {
              attempts: 5,
              delay: 1,
              when: failure => failure.error === 'transient',
            }),
        ],
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

  it('per-action delay override does not change the retry outcome', async () => {
    let attempts = 0
    const service = buildService({
      flaky: defineAction(
        { settings: [RetryPolicy.actions.config({ delay: 2, backoff: 2 })] },
        function* (): Operation<string> {
          attempts++
          if (attempts < 3) {
            return yield* fail('transient', `attempt ${attempts}`)
          }
          return 'ok'
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(RetryPolicy, { attempts: 5, delay: 0 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'flaky')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(attempts).toBe(3)
  })

  it('does not retry streaming calls by default (retryStreams=false)', async () => {
    let attempts = 0
    const service = buildService({
      // a genuinely streaming action — the declaration is what says so
      bad: defineAction({ output: chunks() }, function* (): Operation<never> {
        attempts++
        return yield* fail('always', 'nope')
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(RetryPolicy, { attempts: 5, delay: 1 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* attempt(() => call(service, 'bad'))
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value.ok).toBe(false)
    }
    expect(attempts).toBe(1)
  })

  it('retries streaming calls when retryStreams=true', async () => {
    let attempts = 0
    const service = buildService({
      flaky: defineAction(function* (): Operation<string> {
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
          () => install(RetryPolicy, { attempts: 5, delay: 1, retryStreams: true }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* attempt(() => call(service, 'flaky'))
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(attempts).toBe(3)
  })
})

describe('CircuitBreakerPolicy (edge)', () => {
  it('isFailure predicate: failures it rejects do not count toward the threshold', async () => {
    let attempts = 0
    const service = buildService({
      noisy: defineAction(function* (): Operation<never> {
        attempts++
        return yield* fail('ignore', 'not counted')
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(CircuitBreakerPolicy, {
              threshold: 2,
              resetTimeout: 10_000,
              isFailure: failure => failure.error === 'real',
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          for (let i = 0; i < 5; i++) {
            yield* attempt(() => call(service, 'noisy'))
          }
          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    // none of the 5 failures count → circuit never opens → every call reaches the action
    expect(attempts).toBe(5)
  })

  it('a success resets the consecutive-failure counter', async () => {
    let attempts = 0
    let mode: 'fail' | 'ok' = 'fail'
    const service = buildService({
      maybe: defineAction(function* (): Operation<string> {
        attempts++
        if (mode === 'fail') {
          return yield* fail('boom', 'down')
        }
        return 'ok'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(CircuitBreakerPolicy, { threshold: 3, resetTimeout: 10_000 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          // 2 failures (below threshold 3)
          yield* attempt(() => call(service, 'maybe'))
          yield* attempt(() => call(service, 'maybe'))
          // a success resets the counter
          mode = 'ok'
          yield* call(service, 'maybe')
          // 2 more failures — still below threshold because the counter reset
          mode = 'fail'
          yield* attempt(() => call(service, 'maybe'))
          yield* attempt(() => call(service, 'maybe'))
          // circuit must still be closed → this call reaches the action
          return yield* attempt(() => call(service, 'maybe'))
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value.ok).toBe(false)
      if (!result.value.ok) {
        expect(tagOf(result.value.failure.error)).toBe('boom') // not CircuitOpen
      }
    }
    expect(attempts).toBe(6)
  })

  it('per-action disable bypasses the breaker', async () => {
    let attempts = 0
    const service = buildService({
      down: defineAction(
        { settings: [CircuitBreakerPolicy.actions.disable()] },
        function* (): Operation<never> {
          attempts++
          return yield* fail('boom', 'down')
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(CircuitBreakerPolicy, { threshold: 2, resetTimeout: 10_000 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          for (let i = 0; i < 5; i++) {
            yield* attempt(() => call(service, 'down'))
          }
          return null
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(attempts).toBe(5) // disabled → never fast-fails, every call reaches the action
  })

  it('keeps independent circuits for (service, action) names whose concatenation collides', async () => {
    let qAttempts = 0
    // 'ab' + 'cd' === 'abc' + 'd' — same naive key without a separator
    const serviceP = namedService('ab', {
      cd: defineAction(function* (): Operation<never> {
        return yield* fail('boom', 'down')
      }),
    })
    const serviceQ = namedService('abc', {
      d: defineAction(function* () {
        qAttempts++
        return 'ok'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => serviceP.actions.install(),
          () => serviceQ.actions.install(),
          () => install(CircuitBreakerPolicy, { threshold: 2, resetTimeout: 10_000 }),
        ],
        function* () {
          yield* Broker.actions.register(serviceP)
          yield* Broker.actions.register(serviceQ)
          // open P.cd
          yield* attempt(() => call(serviceP, 'cd'))
          yield* attempt(() => call(serviceP, 'cd'))
          yield* attempt(() => call(serviceP, 'cd'))
          // Q.d must remain independent (its own circuit, still closed)
          return yield* call(serviceQ, 'd')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('ok')
    }
    expect(qAttempts).toBe(1)
  })

  it('halfOpenMax>1: a late successful probe does not re-close a circuit re-opened by a failed probe', async () => {
    let attempts = 0
    let initial = true
    let probe = 0
    const service = buildService({
      maybe: defineAction(function* (): Operation<string> {
        attempts++
        if (initial) {
          return yield* fail('boom', 'down')
        }
        const p = ++probe
        if (p === 1) {
          yield* sleep(5)
          return yield* fail('boom', 'probe-down')
        }
        yield* sleep(40)
        return 'ok'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(CircuitBreakerPolicy, { threshold: 2, resetTimeout: 100, halfOpenMax: 2 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          // open
          yield* attempt(() => call(service, 'maybe'))
          yield* attempt(() => call(service, 'maybe'))
          initial = false
          yield* sleep(130) // past resetTimeout → half-open eligible
          // two concurrent probes: #1 fails (re-opens), #2 succeeds late
          yield* all([attempt(() => call(service, 'maybe')), attempt(() => call(service, 'maybe'))])
          // circuit must still be OPEN (late success did not re-close it)
          return yield* attempt(() => call(service, 'maybe'))
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value.ok).toBe(false)
      if (!result.value.ok) {
        expect(tagOf(result.value.failure.error)).toBe(CoreErrors.CircuitOpen)
      }
    }
    // 2 initial + 2 probes; final fast-fails as CircuitOpen without reaching the action
    expect(attempts).toBe(4)
  })
})

describe('BulkPolicy (edge)', () => {
  it('promotes a queued waiter before its queueTimeout, so it completes successfully', async () => {
    const service = buildService({
      work: defineAction(function* () {
        yield* sleep(30)
        return 'done'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(BulkPolicy, { maxConcurrent: 1, maxQueue: 5, queueTimeout: 200 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          // both succeed: the second is queued (~30ms) then promoted well before its 200ms timeout
          return yield* all([call(service, 'work'), call(service, 'work')])
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual(['done', 'done'])
    }
  })

  it('a failing in-flight call releases its slot for the next waiter', async () => {
    let started = 0
    const service = buildService({
      maybe: defineAction(function* (): Operation<string> {
        started++
        yield* sleep(20)
        if (started === 1) {
          return yield* fail('boom', 'first fails')
        }
        return 'ok'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(BulkPolicy, { maxConcurrent: 1, maxQueue: 5 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          const [first, second] = yield* all([
            attempt(() => call(service, 'maybe')),
            attempt(() => call(service, 'maybe')),
          ])
          return { first, second }
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value.first.ok).toBe(false)
      // the failing first call must have freed its slot so the second could run
      expect(result.value.second.ok).toBe(true)
    }
    expect(started).toBe(2)
  })

  it('drains the queue in FIFO submission order at maxConcurrent=1', async () => {
    const order: number[] = []
    const service = buildService({
      work: defineAction(function* (n: number) {
        yield* sleep(15)
        order.push(n)
        return n
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(BulkPolicy, { maxConcurrent: 1, maxQueue: 10 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* all([
            call(service, 'work', 1),
            call(service, 'work', 2),
            call(service, 'work', 3),
          ])
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual([1, 2, 3])
    }
    // maxConcurrent=1 serializes execution in submission order
    expect(order).toEqual([1, 2, 3])
  })
})

describe('TimeoutPolicy (edge)', () => {
  it('per-action disable bypasses the timeout', async () => {
    const service = buildService({
      slow: defineAction(
        { settings: [TimeoutPolicy.actions.disable()] },
        function* (): Operation<string> {
          yield* sleep(60)
          return 'done'
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(TimeoutPolicy, { timeoutMs: 10 })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'slow')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('done')
    }
  })

  it('times out streaming calls when timeoutStreams=true', async () => {
    const service = buildService({
      slow: defineAction(function* (): Operation<string> {
        yield* sleep(120)
        return 'done'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(TimeoutPolicy, { timeoutMs: 30, timeoutStreams: true }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* attempt(() => call(service, 'slow'))
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value.ok).toBe(false)
      if (!result.value.ok) {
        expect(tagOf(result.value.failure.error)).toBe(CoreErrors.Timeout)
      }
    }
  })

  it('halts the inner work so its post-deadline side effects never run', async () => {
    let completed = false
    const service = buildService({
      slow: defineAction(function* (): Operation<string> {
        yield* sleep(40)
        completed = true
        return 'done'
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(TimeoutPolicy, { timeoutMs: 20 })],
        function* () {
          yield* Broker.actions.register(service)
          const r = yield* attempt(() => call(service, 'slow'))
          // wait well past when the inner sleep(40) would have completed
          yield* sleep(60)
          return r
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value.ok).toBe(false)
    }
    // halt cancelled the inner sleep → the side effect after it must not have run
    expect(completed).toBe(false)
  })
})

describe('FallbackPolicy (edge)', () => {
  it('per-action config can override a global fallback value with undefined (presence-based)', async () => {
    const service = buildService({
      bad: defineAction(
        { settings: [FallbackPolicy.actions.config({ value: undefined })] },
        function* (): Operation<undefined> {
          return yield* fail('boom', 'broken')
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(FallbackPolicy, { value: 'global-fallback' }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'bad')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      // the per-action `value: undefined` overrides the global string
      expect(result.value).toBeUndefined()
    }
  })

  it('when() returning true applies the fallback', async () => {
    const service = buildService({
      bad: defineAction(
        {
          settings: [
            FallbackPolicy.actions.config({
              value: 'recovered',
              when: failure => failure.error === 'transient',
            }),
          ],
        },
        function* (): Operation<string> {
          return yield* fail('transient', 'retryable')
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
      expect(result.value).toBe('recovered')
    }
  })

  it('per-action disable lets the failure propagate', async () => {
    const service = buildService({
      bad: defineAction(
        { settings: [FallbackPolicy.actions.disable()] },
        function* (): Operation<never> {
          return yield* fail('boom', 'broken')
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(FallbackPolicy, { value: 'never-used' })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'bad')
        },
      ),
    )

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(tagOf(result.error)).toBe('boom')
    }
  })

  it('propagates a failure thrown by the fallback handler itself', async () => {
    const service = buildService({
      bad: defineAction(
        {
          settings: [
            FallbackPolicy.actions.config({
              *handler(): Operation<never> {
                return yield* fail('handler-failed', 'fallback blew up')
              },
            }),
          ],
        },
        function* (): Operation<never> {
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

    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) {
      expect(tagOf(result.error)).toBe('handler-failed')
    }
  })
})

describe('MetricsPolicy (edge)', () => {
  it('a throwing onSuccess hook does not turn a successful dispatch into a failure', async () => {
    let onFailureCalls = 0
    const service = buildService({
      hello: defineAction(function* () {
        return 'hi'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(MetricsPolicy, {
              onSuccess: () => {
                throw new Error('exporter exploded')
              },
              onFailure: () => {
                onFailureCalls++
              },
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'hello')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('hi')
    }
    // the throwing onSuccess must NOT be misreported as a failure
    expect(onFailureCalls).toBe(0)
  })

  it('a throwing onCall hook does not affect the dispatch', async () => {
    const service = buildService({
      hello: defineAction(function* () {
        return 'hi'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () =>
            install(MetricsPolicy, {
              onCall: () => {
                throw new Error('onCall exploded')
              },
            }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'hello')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('hi')
    }
  })

  it('per-action disable suppresses metric events', async () => {
    let calls = 0
    const service = buildService({
      hello: defineAction({ settings: [MetricsPolicy.actions.disable()] }, function* () {
        return 'hi'
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(MetricsPolicy, { onCall: () => calls++ })],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'hello')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(calls).toBe(0)
  })

  it('records a timeout as onFailure (timeout sits inside metrics by default)', async () => {
    let onCall = 0
    let onSuccess = 0
    let failureError: unknown
    const service = buildService({
      slow: defineAction(function* (): Operation<string> {
        yield* sleep(120)
        return 'done'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          // metrics (priority 50) wraps timeout (priority 60) → the timeout surfaces as a
          // normal CoreErrors.Timeout failure that metrics observes through onFailure
          () =>
            install(MetricsPolicy, {
              onCall: () => onCall++,
              onSuccess: () => onSuccess++,
              onFailure: e => {
                failureError = e.failure.error
              },
            }),
          () => install(TimeoutPolicy, { timeoutMs: 30 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* attempt(() => call(service, 'slow'))
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    expect(onCall).toBe(1)
    expect(onSuccess).toBe(0)
    expect(failureError).toBe(CoreErrors.Timeout)
  })
})

describe('policy composition (edge)', () => {
  it('a timed-out half-open probe counts as a failure (timeout inside breaker) and the breaker still recovers', async () => {
    let attempts = 0
    let phase: 'fail' | 'slow' | 'ok' = 'fail'
    const service = buildService({
      maybe: defineAction(function* (): Operation<string> {
        attempts++
        if (phase === 'fail') {
          return yield* fail('boom', 'down')
        }
        if (phase === 'slow') {
          yield* sleep(120) // slower than the timeout → the half-open probe times out
          return 'slow-ok'
        }
        return 'ok'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          // circuit-breaker (40) wraps timeout (60): the timeout surfaces as a normal failure
          // the breaker observes through its catch — it re-opens, and the slot is freed
          () => install(CircuitBreakerPolicy, { threshold: 2, resetTimeout: 40, halfOpenMax: 1 }),
          () => install(TimeoutPolicy, { timeoutMs: 40 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          // open the circuit
          yield* attempt(() => call(service, 'maybe'))
          yield* attempt(() => call(service, 'maybe'))
          // half-open probe that times out → counts as a failure → re-opens
          phase = 'slow'
          yield* sleep(60)
          const timedOut = yield* attempt(() => call(service, 'maybe'))
          // after the next reset window a fast success closes the circuit again
          phase = 'ok'
          yield* sleep(60)
          const recovered = yield* attempt(() => call(service, 'maybe'))
          return { timedOut, recovered }
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value.timedOut.ok).toBe(false)
      if (!result.value.timedOut.ok) {
        expect(tagOf(result.value.timedOut.failure.error)).toBe(CoreErrors.Timeout)
      }
      expect(result.value.recovered.ok).toBe(true)
      if (result.value.recovered.ok) {
        expect(result.value.recovered.value).toBe('ok')
      }
    }
    // 2 opens + 1 timed-out probe + 1 successful recovery
    expect(attempts).toBe(4)
  })

  it('fallback serves a value after retry exhausts its attempts', async () => {
    let attempts = 0
    const service = buildService({
      bad: defineAction(
        { settings: [FallbackPolicy.actions.config({ value: 'fallback' })] },
        function* (): Operation<string> {
          attempts++
          return yield* fail('always', 'nope')
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(FallbackPolicy),
          () => install(RetryPolicy, { attempts: 3, delay: 1 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          return yield* call(service, 'bad')
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toBe('fallback')
    }
    // fallback (outer, priority 5) wraps retry (30): retry exhausts 3 attempts, then fallback serves
    expect(attempts).toBe(3)
  })

  it('fallback catches a CircuitOpen fast-fail from the circuit breaker', async () => {
    const service = buildService({
      down: defineAction(
        { settings: [FallbackPolicy.actions.config({ value: 'degraded' })] },
        function* (): Operation<string> {
          return yield* fail('boom', 'down')
        },
      ),
    })

    const result = await run(() =>
      withBroker(
        [
          () => service.actions.install(),
          () => install(FallbackPolicy),
          () => install(CircuitBreakerPolicy, { threshold: 2, resetTimeout: 10_000 }),
        ],
        function* () {
          yield* Broker.actions.register(service)
          // first two failures pass through fallback's `value` too, but they open the breaker
          const a = yield* call(service, 'down')
          const b = yield* call(service, 'down')
          // now the breaker is open → CircuitOpen, which fallback also catches
          const c = yield* call(service, 'down')
          return [a, b, c]
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual(['degraded', 'degraded', 'degraded'])
    }
  })
})

describe('core wiring (edge)', () => {
  it('a per-action setting for an uninstalled policy does not break other policies', async () => {
    let dispatchCount = 0
    const service = buildService({
      // configures RetryPolicy, which is NOT installed below — its setting must be skipped,
      // not propagated as a dispatch failure out of CachePolicy.apply
      get: defineAction({ settings: [RetryPolicy.actions.config({ attempts: 5 })] }, function* () {
        dispatchCount++
        return 'value'
      }),
    })

    const result = await run(() =>
      withBroker(
        [() => service.actions.install(), () => install(CachePolicy, { ttl: 60_000 })],
        function* () {
          yield* Broker.actions.register(service)
          const a = yield* call(service, 'get')
          const b = yield* call(service, 'get')
          return [a, b]
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual(['value', 'value'])
    }
    // cache still works (the unresolved retry setting was skipped, not fatal)
    expect(dispatchCount).toBe(1)
  })

  it('does not coalesce calls whose service+action names would collide without a key separator', async () => {
    const serviceP = namedService('ab', {
      cd: defineAction(function* (): Operation<string> {
        yield* sleep(30)
        return 'from-P'
      }),
    })
    const serviceQ = namedService('abc', {
      d: defineAction(function* (): Operation<string> {
        yield* sleep(30)
        return 'from-Q'
      }),
    })

    const result = await run(() =>
      withBroker(
        [
          () => serviceP.actions.install(),
          () => serviceQ.actions.install(),
          () => install(BucketPolicy, { interval: 100, max: 100 }),
        ],
        function* () {
          yield* Broker.actions.register(serviceP)
          yield* Broker.actions.register(serviceQ)
          // 'ab'+'cd' and 'abc'+'d' both concatenate to "abcd" — concurrent in-flight calls
          // must NOT coalesce into one another's bucket
          return yield* all([call(serviceP, 'cd'), call(serviceQ, 'd')])
        },
      ),
    )

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual(['from-P', 'from-Q'])
    }
  })
})
