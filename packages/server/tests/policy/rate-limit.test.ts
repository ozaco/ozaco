import { Broker, CoreErrors, defineAction, defineService } from 'server:core'
import { attempt } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { RateLimitPolicy } from 'server:policy/rate-limit'

import { bootstrap } from '../core/helpers'
import { runResult, runScoped } from '../helpers'

const fixture = (counter: { runs: number }) =>
  defineService({
    name: 'limited-svc',
    actions: {
      ping: defineAction(function* () {
        counter.runs += 1

        return 'pong'
      }),
    },
  })

describe('policy: rate-limit', () => {
  it('raises RateLimited once the bucket is exhausted', async () => {
    const counter = { runs: 0 }
    const failure = await runResult(function* () {
      const service = fixture(counter)

      yield* bootstrap()
      yield* install(RateLimitPolicy, { capacity: 2, refillPerSecond: 0.001 })
      yield* Broker.actions.register(service)

      yield* Broker.actions.call(service, 'ping', undefined)
      yield* Broker.actions.call(service, 'ping', undefined)
      yield* Broker.actions.call(service, 'ping', undefined)
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.RateLimited)
      expect(failure.message).toBe('rate limit exceeded for limited-svc.ping')
      expect(failure.causes.includes('policy:rate-limit')).toBe(true)
    }

    expect(counter.runs).toBe(2)
  })

  it('a generous bucket never limits', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = fixture(counter)

      yield* bootstrap()
      yield* install(RateLimitPolicy, { capacity: 100, refillPerSecond: 100 })
      yield* Broker.actions.register(service)

      for (let index = 0; index < 5; index += 1) {
        yield* Broker.actions.call(service, 'ping', undefined)
      }

      return counter.runs
    })

    expect(result).toBe(5)
  })

  it('vary principal gives every caller its own bucket', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = fixture(counter)

      yield* bootstrap()
      yield* install(RateLimitPolicy, { capacity: 1, refillPerSecond: 0.001 })
      yield* Broker.actions.register(service)

      const alice = { meta: { authorization: 'alice' } }
      const bob = { meta: { authorization: 'bob' } }

      yield* Broker.actions.call(service, 'ping', undefined, alice)
      yield* Broker.actions.call(service, 'ping', undefined, bob)

      const limited = yield* attempt(() => Broker.actions.call(service, 'ping', undefined, alice))

      return { limited, runs: counter.runs }
    })

    expect(result.runs).toBe(2)
    expect(isFailure(result.limited)).toBe(true)

    if (isFailure(result.limited)) {
      expect(result.limited.error).toBe(CoreErrors.RateLimited)
    }
  })
})
