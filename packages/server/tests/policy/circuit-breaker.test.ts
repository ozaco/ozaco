import { Broker, CoreErrors, defineAction, defineService } from 'server:core'
import { attempt, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'
import type { Result } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { CircuitBreakerPolicy } from 'server:policy/circuit-breaker'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

interface Toggle {
  failing: boolean
  runs: number
}

/** `run` fails with a 500-mapped tag while `toggle.failing`; `missing` always fails as 404. */
const fixture = (toggle: Toggle) =>
  defineService({
    name: 'breaker-svc',
    actions: {
      run: defineAction(function* () {
        toggle.runs += 1

        if (toggle.failing) {
          return yield* fail('breaker-svc.boom', 'kaboom')
        }

        return 'ok'
      }),
      missing: defineAction({ errors: { 'breaker-svc.missing': 404 } }, function* () {
        toggle.runs += 1

        return yield* fail('breaker-svc.missing', 'no such thing')
      }),
    },
  })

const errorOf = (outcome: Result<unknown, unknown>): unknown =>
  isFailure(outcome) ? outcome.error : undefined

describe('policy: circuit-breaker', () => {
  it('opens after threshold failures and rejects immediately while open', async () => {
    const toggle: Toggle = { failing: true, runs: 0 }
    const result = await runScoped(function* () {
      const service = fixture(toggle)

      yield* bootstrap()
      yield* install(CircuitBreakerPolicy, { threshold: 2, resetTimeoutMs: 60_000 })
      yield* Broker.actions.register(service)

      const first = yield* attempt(() => Broker.actions.call(service, 'run', undefined))
      const second = yield* attempt(() => Broker.actions.call(service, 'run', undefined))
      const rejected = yield* attempt(() => Broker.actions.call(service, 'run', undefined))

      return { first, second, rejected }
    })

    expect(errorOf(result.first)).toBe('breaker-svc.boom')
    expect(errorOf(result.second)).toBe('breaker-svc.boom')
    expect(errorOf(result.rejected)).toBe(CoreErrors.Unavailable)

    if (isFailure(result.rejected)) {
      expect(result.rejected.message).toBe('circuit open for breaker-svc.run')
      expect(result.rejected.causes.includes('policy:circuit-breaker')).toBe(true)
    }

    // the handler never ran for the rejected dispatch — the counter is frozen
    expect(toggle.runs).toBe(2)
  })

  it('business 4xx failure replies do not trip the breaker', async () => {
    const toggle: Toggle = { failing: false, runs: 0 }
    const result = await runScoped(function* () {
      const service = fixture(toggle)

      yield* bootstrap()
      yield* install(CircuitBreakerPolicy, { threshold: 1 })
      yield* Broker.actions.register(service)

      const first = yield* attempt(() => Broker.actions.call(service, 'missing', undefined))
      const second = yield* attempt(() => Broker.actions.call(service, 'missing', undefined))

      return { first, second }
    })

    expect(errorOf(result.first)).toBe('breaker-svc.missing')
    expect(errorOf(result.second)).toBe('breaker-svc.missing')
    expect(toggle.runs).toBe(2)
  })

  it('half-open after resetTimeoutMs: a successful probe closes the breaker', async () => {
    const toggle: Toggle = { failing: true, runs: 0 }
    const result = await runScoped(function* () {
      const service = fixture(toggle)

      yield* bootstrap()
      yield* install(CircuitBreakerPolicy, { threshold: 1, resetTimeoutMs: 50 })
      yield* Broker.actions.register(service)

      yield* attempt(() => Broker.actions.call(service, 'run', undefined))

      const rejected = yield* attempt(() => Broker.actions.call(service, 'run', undefined))

      yield* sleep(70)

      toggle.failing = false

      const probe = yield* Broker.actions.call(service, 'run', undefined)
      const closed = yield* Broker.actions.call(service, 'run', undefined)

      return { rejected, probe, closed }
    })

    expect(errorOf(result.rejected)).toBe(CoreErrors.Unavailable)
    expect(result.probe).toBe('ok')
    expect(result.closed).toBe('ok')
    expect(toggle.runs).toBe(3)
  })

  it('a failed half-open probe re-opens the circuit', async () => {
    const toggle: Toggle = { failing: true, runs: 0 }
    const result = await runScoped(function* () {
      const service = fixture(toggle)

      yield* bootstrap()
      yield* install(CircuitBreakerPolicy, { threshold: 1, resetTimeoutMs: 50 })
      yield* Broker.actions.register(service)

      yield* attempt(() => Broker.actions.call(service, 'run', undefined))
      yield* sleep(70)

      const probe = yield* attempt(() => Broker.actions.call(service, 'run', undefined))
      const rejected = yield* attempt(() => Broker.actions.call(service, 'run', undefined))

      return { probe, rejected }
    })

    expect(errorOf(result.probe)).toBe('breaker-svc.boom')
    expect(errorOf(result.rejected)).toBe(CoreErrors.Unavailable)
    expect(toggle.runs).toBe(2)
  })
})
