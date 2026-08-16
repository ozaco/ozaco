import { Broker, defineAction, definePolicy, defineService } from 'server:core'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { CachePolicy } from 'server:policy/cache'
import { RetryPolicy } from 'server:policy/retry'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

const probe = (order: string[], name: string, priority: number) =>
  definePolicy<void, void>({
    name,
    priority,
    *setup() {},
    *apply({ next }) {
      order.push(`${name}:before`)

      const reply = yield* next()

      order.push(`${name}:after`)

      return reply
    },
  })

describe('policy composition', () => {
  it('cache sits outside retry: retries wrap the inner layers, hits skip everything', async () => {
    const order: string[] = []
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = defineService({
        name: 'composed-svc',
        actions: {
          shaky: defineAction(function* () {
            counter.runs += 1

            if (counter.runs < 3) {
              return yield* fail('composed-svc.shaky', 'not yet')
            }

            return 'recovered'
          }),
        },
      })

      yield* bootstrap()
      yield* install(CachePolicy, { global: true })
      yield* install(RetryPolicy, {
        attempts: 3,
        delayMs: 1,
        when: failure => failure.error === 'composed-svc.shaky',
      })
      // between cache (0) and retry (30) — must run once per call, not per attempt
      yield* install(probe(order, 'mid', 15))
      // inside retry (30) — must run once per ATTEMPT
      yield* install(probe(order, 'inner', 55))
      yield* Broker.actions.register(service)

      const first = yield* Broker.actions.call(service, 'shaky', undefined)
      const afterFirst = order.length

      const second = yield* Broker.actions.call(service, 'shaky', undefined)
      const afterSecond = order.length

      return { first, second, afterFirst, afterSecond, runs: counter.runs }
    })

    // first call: mid once around, inner once per attempt (3 attempts)
    expect(order.filter(entry => entry === 'mid:before')).toHaveLength(1)
    expect(order.filter(entry => entry === 'inner:before')).toHaveLength(3)
    expect(order[0]).toBe('mid:before')
    expect(order.at(-1)).toBe('mid:after')

    // second call: cache (outermost) served the reply — nothing below it ran again
    expect(result.afterSecond).toBe(result.afterFirst)
    expect(result.first).toBe('recovered')
    expect(result.second).toBe('recovered')
    expect(result.runs).toBe(3)
  })
})
