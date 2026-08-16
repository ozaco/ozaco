import { Broker, CoreErrors, defineAction, defineService } from 'server:core'
import { attempt, sleep, spawn } from 'std:effect'
import type { Task } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BulkPolicy } from 'server:policy/bulk'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

interface Gauge {
  active: number
  maxActive: number
  finished: string[]
}

const fixture = (gauge: Gauge, delayMs: number) =>
  defineService({
    name: 'bulk-svc',
    actions: {
      work: defineAction(function* (params: { id: string }) {
        gauge.active += 1
        gauge.maxActive = Math.max(gauge.maxActive, gauge.active)

        yield* sleep(delayMs)

        gauge.active -= 1
        gauge.finished.push(params.id)

        return params.id
      }),
    },
  })

describe('policy: bulk (bulkhead)', () => {
  it('maxConcurrent=1 queues the overflow and preserves arrival order', async () => {
    const gauge: Gauge = { active: 0, maxActive: 0, finished: [] }

    await runScoped(function* () {
      const service = fixture(gauge, 20)

      yield* bootstrap()
      yield* install(BulkPolicy, { maxConcurrent: 1 })
      yield* Broker.actions.register(service)

      const tasks: Task<unknown>[] = []

      for (const id of ['a', 'b', 'c']) {
        tasks.push(yield* spawn(() => Broker.actions.call(service, 'work', { id })))
        yield* sleep(2)
      }

      for (const task of tasks) {
        yield* task
      }
    })

    expect(gauge.finished).toEqual(['a', 'b', 'c'])
    expect(gauge.maxActive).toBe(1)
  })

  it('a full queue raises Unavailable immediately', async () => {
    const { failure } = await runScoped(function* () {
      const gauge: Gauge = { active: 0, maxActive: 0, finished: [] }
      const service = fixture(gauge, 40)

      yield* bootstrap()
      yield* install(BulkPolicy, { maxConcurrent: 1, maxQueue: 1 })
      yield* Broker.actions.register(service)

      const first = yield* spawn(() => Broker.actions.call(service, 'work', { id: 'a' }))

      yield* sleep(5)

      const second = yield* spawn(() => Broker.actions.call(service, 'work', { id: 'b' }))

      yield* sleep(5)

      const third = yield* attempt(() => Broker.actions.call(service, 'work', { id: 'c' }))

      yield* first
      yield* second

      // wrapped: a bare Result.Failure return would collapse into the run outcome
      return { failure: third }
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.Unavailable)
      expect(failure.message).toBe('bulkhead queue is full')
      expect(failure.causes.includes('policy:bulk')).toBe(true)
    }
  })

  it('a queued dispatch waiting longer than queueTimeoutMs raises Unavailable', async () => {
    const { failure } = await runScoped(function* () {
      const gauge: Gauge = { active: 0, maxActive: 0, finished: [] }
      const service = fixture(gauge, 200)

      yield* bootstrap()
      yield* install(BulkPolicy, { maxConcurrent: 1, queueTimeoutMs: 20 })
      yield* Broker.actions.register(service)

      yield* spawn(() => Broker.actions.call(service, 'work', { id: 'a' }))
      yield* sleep(5)

      const outcome = yield* attempt(() => Broker.actions.call(service, 'work', { id: 'b' }))

      // wrapped: a bare Result.Failure return would collapse into the run outcome
      return { failure: outcome }
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.Unavailable)
      expect(failure.message).toContain('exceeded 20ms')
      expect(failure.causes.includes('policy:bulk queue-timeout')).toBe(true)
    }
  })
})
