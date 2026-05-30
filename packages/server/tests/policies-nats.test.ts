import { describe, expect, it } from 'bun:test'

import { Broker, CoreErrors, DefaultBroker, defineAction, defineService } from '@ozaco/server/core'
import { CachePolicy } from '@ozaco/server/policy/cache'
import { CircuitBreakerPolicy } from '@ozaco/server/policy/circuit-breaker'
import { FallbackPolicy } from '@ozaco/server/policy/fallback'
import { MetricsPolicy } from '@ozaco/server/policy/metrics'
import { RetryPolicy } from '@ozaco/server/policy/retry'
import { TimeoutPolicy } from '@ozaco/server/policy/timeout'
import { NatsTransport } from '@ozaco/server/transport/nats'
import type { Operation } from '@ozaco/std/effect'
import { all, run, sleep, suspend } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import type { Result } from '@ozaco/std/result'
import { fail, isFailure, isSuccess } from '@ozaco/std/result'

const NATS_URL = process.env.NATS_URL ?? 'nats://localhost:4222'

const natsAvailable = await (async () => {
  try {
    const { connect } = await import('nats')
    const c = await connect({ servers: NATS_URL })
    await c.close()
    return true
  } catch {
    console.warn(`[nats-tests] NATS not reachable at ${NATS_URL}; suite skipped`)
    return false
  }
})()

type Action = ReturnType<typeof defineAction>

const buildService = <T extends Record<string, Action>>(actions: T) =>
  defineService({
    name: `nats-test-${Math.random().toString(36).slice(2, 10)}`,
    version: '0.0.0',
    actions,
    *setup() {},
  })

interface Harness<T> {
  serverTask: { halt(): Promise<unknown> } & PromiseLike<Result<unknown, unknown>>
  clientResult: Result<T, unknown>
}

const wait = (ms: number) =>
  new Promise<void>(resolve => {
    setTimeout(() => resolve(), ms)
  })

const runWithNats = async <T, E>(
  service: ReturnType<typeof buildService>,
  policyInstalls: ReadonlyArray<() => Operation<unknown, unknown>>,
  body: () => Operation<T, E>,
): Promise<Harness<T>> => {
  const ready = Promise.withResolvers<void>()

  const serverTask = run(function* () {
    yield* install(BunIO)
    yield* install(DefaultLogger, { level: LogLevel.silent })
    yield* install(DefaultBroker)
    yield* install(service)
    yield* install(NatsTransport, { servers: NATS_URL })
    yield* Broker.actions.register(service)
    yield* Broker.actions.start()
    ready.resolve()
    yield* suspend()
  })

  await ready.promise
  await wait(50)

  const clientResult = await run(function* () {
    yield* install(BunIO)
    yield* install(DefaultLogger, { level: LogLevel.silent })
    yield* install(DefaultBroker)
    yield* install(service)
    yield* install(NatsTransport, { servers: NATS_URL })
    for (const op of policyInstalls) {
      yield* op()
    }
    yield* Broker.actions.start()
    return yield* body()
  })

  return { serverTask, clientResult }
}

const teardown = async (h: Harness<unknown>) => {
  await h.serverTask.halt()
  await h.serverTask
}

describe.skipIf(!natsAvailable)('Policies over NATS', () => {
  it('CachePolicy: caches NATS round-trips on the client side', async () => {
    let serverDispatches = 0
    const service = buildService({
      hello: defineAction(function* (name: string) {
        serverDispatches++
        return `hi ${name}`
      }),
    })

    const h = await runWithNats(service, [() => install(CachePolicy, { ttl: 5000 })], function* () {
      const a = yield* Broker.actions.call(service.actions.hello, ['world'])
      const b = yield* Broker.actions.call(service.actions.hello, ['world'])
      const c = yield* Broker.actions.call(service.actions.hello, ['other'])
      return [a, b, c]
    })
    await teardown(h)

    expect(isSuccess(h.clientResult)).toBe(true)
    if (isSuccess(h.clientResult)) {
      expect(h.clientResult.value).toEqual(['hi world', 'hi world', 'hi other'])
    }
    expect(serverDispatches).toBe(2)
  })

  it('RetryPolicy: retries transient remote failures', async () => {
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

    const h = await runWithNats(
      service,
      [() => install(RetryPolicy, { attempts: 5, delay: 5 })],
      function* () {
        return yield* Broker.actions.call(service.actions.flaky, [])
      },
    )
    await teardown(h)

    expect(isSuccess(h.clientResult)).toBe(true)
    if (isSuccess(h.clientResult)) {
      expect(h.clientResult.value).toBe('ok')
    }
    expect(attempts).toBe(3)
  })

  it('TimeoutPolicy: fires when remote service is slow', async () => {
    const service = buildService({
      slow: defineAction(function* () {
        yield* sleep(500)
        return 'done'
      }),
    })

    const h = await runWithNats(
      service,
      [() => install(TimeoutPolicy, { timeoutMs: 50 })],
      function* () {
        return yield* Broker.actions.call(service.actions.slow, [])
      },
    )
    await teardown(h)

    expect(isFailure(h.clientResult)).toBe(true)
    if (isFailure(h.clientResult)) {
      expect(h.clientResult.error).toBe(CoreErrors.Timeout)
    }
  })

  it('FallbackPolicy: catches NATS-relayed failure via per-action setting', async () => {
    const service = buildService({
      bad: defineAction(
        { settings: [FallbackPolicy.actions.config({ value: 'fallback-value' })] },
        function* (): Operation<string, 'boom'> {
          return yield* fail('boom', 'always')
        },
      ),
    })

    const h = await runWithNats(service, [() => install(FallbackPolicy)], function* () {
      return yield* Broker.actions.call(service.actions.bad, [])
    })
    await teardown(h)

    expect(isSuccess(h.clientResult)).toBe(true)
    if (isSuccess(h.clientResult)) {
      expect(h.clientResult.value).toBe('fallback-value')
    }
  })

  it('MetricsPolicy: tracks NATS calls + durations', async () => {
    const callEvents: string[] = []
    const successEvents: string[] = []
    const service = buildService({
      hello: defineAction(function* (name: string) {
        yield* sleep(5)
        return `hi ${name}`
      }),
    })

    const h = await runWithNats(
      service,
      [
        () =>
          install(MetricsPolicy, {
            onCall: e => callEvents.push(`${e.serviceName}.${e.actionKey}`),
            onSuccess: e => successEvents.push(String(e.value)),
          }),
      ],
      function* () {
        return yield* all([
          Broker.actions.call(service.actions.hello, ['a']),
          Broker.actions.call(service.actions.hello, ['b']),
        ])
      },
    )
    await teardown(h)

    expect(isSuccess(h.clientResult)).toBe(true)
    expect(callEvents).toHaveLength(2)
    expect(successEvents.toSorted()).toEqual(['hi a', 'hi b'])
  })

  it('CircuitBreakerPolicy: opens after threshold of NATS-relayed failures', async () => {
    let attempts = 0
    const service = buildService({
      down: defineAction(function* () {
        attempts++
        return yield* fail('boom', 'down')
      }),
    })

    let circuitOpen = false
    const h = await runWithNats(
      service,
      [() => install(CircuitBreakerPolicy, { threshold: 2, resetTimeout: 10_000 })],
      function* () {
        for (let i = 0; i < 2; i++) {
          try {
            yield* Broker.actions.call(service.actions.down, [])
          } catch {
            // expected
          }
        }
        try {
          yield* Broker.actions.call(service.actions.down, [])
        } catch (error) {
          if (isFailure(error) && error.error === CoreErrors.CircuitOpen) {
            circuitOpen = true
          }
        }
        return null
      },
    )
    await teardown(h)

    expect(isSuccess(h.clientResult)).toBe(true)
    expect(attempts).toBe(2)
    expect(circuitOpen).toBe(true)
  })

  it('chained policies work together across NATS', async () => {
    let serverDispatches = 0
    let attempts = 0
    const service = buildService({
      tricky: defineAction(function* () {
        attempts++
        if (attempts === 1) {
          serverDispatches++
          return yield* fail('transient', 'first one fails')
        }
        serverDispatches++
        return 'eventual-ok'
      }),
    })

    const h = await runWithNats(
      service,
      [
        () => install(CachePolicy, { ttl: 5000 }),
        () => install(RetryPolicy, { attempts: 3, delay: 5 }),
      ],
      function* () {
        const a = yield* Broker.actions.call(service.actions.tricky, [])
        const b = yield* Broker.actions.call(service.actions.tricky, [])
        return [a, b]
      },
    )
    await teardown(h)

    expect(isSuccess(h.clientResult)).toBe(true)
    if (isSuccess(h.clientResult)) {
      expect(h.clientResult.value).toEqual(['eventual-ok', 'eventual-ok'])
    }
    expect(attempts).toBe(2) // 1st call fails+retries; 2nd is cache hit
    expect(serverDispatches).toBe(2)
  })
})
