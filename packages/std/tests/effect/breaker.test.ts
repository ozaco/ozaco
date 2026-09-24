import type { Operation } from 'std:effect'
import {
  EffectCauses,
  EffectErrors,
  attempt,
  createBreaker,
  run,
  sleep,
  spawn,
  suspend,
  withResolvers,
} from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

const tick = (ms = 5) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

const clock = () => {
  let time = 0
  return { now: () => time, advance: (ms: number) => (time += ms) }
}

function* boom(): Operation<never> {
  return yield* fail('breaker-test.boom', 'downstream failed')
}

function* ok(): Operation<string> {
  return 'ok'
}

const errorOf = (result: Result<unknown, unknown>) => (isFailure(result) ? result.error : null)

describe('createBreaker', () => {
  it('trips open after N consecutive failures and then fails fast without calling op', async () => {
    const time = clock()
    const breaker = createBreaker({ failures: 2, halfOpenMs: 100, now: time.now, name: 'db' })
    let calls = 0

    const counted = function* (): Operation<never> {
      calls += 1
      return yield* boom()
    }

    const outcome = await run(function* () {
      const first = yield* attempt(() => breaker.run(counted))
      const stateAfterFirst = breaker.state()
      const second = yield* attempt(() => breaker.run(counted))
      const third = yield* attempt(() => breaker.run(counted))

      return { first, stateAfterFirst, second, third }
    })

    const { first, stateAfterFirst, second, third } = unwrap(outcome)
    expect(errorOf(first)).toBe('breaker-test.boom')
    expect(stateAfterFirst).toBe('closed')
    expect(errorOf(second)).toBe('breaker-test.boom')
    expect(errorOf(third)).toBe(EffectErrors.BreakerOpen)
    expect(isFailure(third) && third.causes).toContain(EffectCauses.Breaker)
    expect(isFailure(third) && third.message).toContain('db: circuit open')
    expect(calls).toBe(2)
    expect(breaker.state()).toBe('open')
    expect(isFailure(breaker.reason) && breaker.reason.error).toBe('breaker-test.boom')
  })

  it('a success resets the consecutive failure count', async () => {
    const breaker = createBreaker({ failures: 2 })

    await run(function* () {
      yield* attempt(() => breaker.run(boom))
      expect(breaker.failures).toBe(1)
      yield* breaker.run(ok)
      expect(breaker.failures).toBe(0)
      yield* attempt(() => breaker.run(boom))
    })

    expect(breaker.state()).toBe('closed')
  })

  it('half-opens after halfOpenMs: one trial at a time, a success closes the circuit', async () => {
    const time = clock()
    const breaker = createBreaker({ failures: 1, halfOpenMs: 100, now: time.now })

    const outcome = await run(function* () {
      yield* attempt(() => breaker.run(boom))
      time.advance(99)
      const stillOpen = breaker.state()
      time.advance(1)
      const halfOpen = breaker.state()

      const release = withResolvers<void>()
      const trial = yield* spawn(() =>
        breaker.run(function* () {
          yield* release.operation
          return 'trial'
        }),
      )
      yield* sleep(1)

      const concurrent = yield* attempt(() => breaker.run(ok))
      release.resolve()
      const trialValue = yield* trial

      return { stillOpen, halfOpen, concurrent: errorOf(concurrent), trialValue }
    })

    expect(unwrap(outcome)).toEqual({
      stillOpen: 'open',
      halfOpen: 'half-open',
      concurrent: EffectErrors.BreakerOpen,
      trialValue: 'trial',
    })
    expect(breaker.state()).toBe('closed')
    expect(breaker.reason).toBeUndefined()
  })

  it('a failed trial re-opens the circuit for another halfOpenMs', async () => {
    const time = clock()
    const breaker = createBreaker({ failures: 3, halfOpenMs: 100, now: time.now })
    breaker.trip('manual')

    await run(function* () {
      time.advance(100)
      const trial = yield* attempt(() => breaker.run(boom))
      expect(errorOf(trial)).toBe('breaker-test.boom')
    })

    expect(breaker.state()).toBe('open')
    time.advance(50)
    expect(breaker.state()).toBe('open')
    time.advance(50)
    expect(breaker.state()).toBe('half-open')
  })

  it('a halted trial frees the probe slot for the next caller', async () => {
    const time = clock()
    const breaker = createBreaker({ failures: 1, halfOpenMs: 10, now: time.now })
    breaker.trip('manual')
    time.advance(10)

    const trial = run(() => breaker.run(suspend))
    await tick(5)
    await trial.halt()

    expect(breaker.state()).toBe('half-open')
    expect(unwrap(await run(() => breaker.run(ok)))).toBe('ok')
    expect(breaker.state()).toBe('closed')
  })

  it('a terminal trip never half-opens; reset() closes it', async () => {
    const time = clock()
    const breaker = createBreaker({ failures: 5, halfOpenMs: 10, now: time.now })
    breaker.trip('credentials revoked', { terminal: true })
    time.advance(1_000_000)

    expect(breaker.state()).toBe('open')
    expect(breaker.reason).toBe('credentials revoked')

    const blocked = await run(() => breaker.run(ok))
    expect(errorOf(blocked)).toBe(EffectErrors.BreakerOpen)
    expect(isFailure(blocked) && blocked.message).toContain('credentials revoked')

    breaker.reset()
    expect(breaker.state()).toBe('closed')
    expect(unwrap(await run(() => breaker.run(ok)))).toBe('ok')
  })

  it('only failures accepted by `when` count towards tripping', async () => {
    const breaker = createBreaker({
      failures: 1,
      when: failure => failure.error !== 'breaker-test.ignored',
    })

    await run(function* () {
      const ignored = yield* attempt(() => breaker.run(() => fail('breaker-test.ignored', '')))
      expect(errorOf(ignored)).toBe('breaker-test.ignored')
      expect(breaker.state()).toBe('closed')

      yield* attempt(() => breaker.run(boom))
    })

    expect(breaker.state()).toBe('open')
  })
})
