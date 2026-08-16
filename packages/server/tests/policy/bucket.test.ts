import { Broker, defineAction, defineService } from 'server:core'
import type { Reply } from 'server:core'
import { sleep, spawn } from 'std:effect'
import type { Task } from 'std:effect'
import { install } from 'std:plugin'
import { fail } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BucketPolicy } from 'server:policy/bucket'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

describe('policy: bucket (single-flight)', () => {
  it('coalesces concurrent dispatches with the same key into one execution', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = defineService({
        name: 'coalesced-svc',
        actions: {
          get: defineAction(function* () {
            counter.runs += 1

            yield* sleep(20)

            return `value-${counter.runs}`
          }),
        },
      })

      yield* bootstrap()
      yield* install(BucketPolicy, {})
      yield* Broker.actions.register(service)

      const tasks: Task<unknown>[] = []

      for (let index = 0; index < 5; index += 1) {
        tasks.push(yield* spawn(() => Broker.actions.call(service, 'get', undefined)))
      }

      const values: unknown[] = []

      for (const task of tasks) {
        values.push(yield* task)
      }

      // the flight settled — a later dispatch starts a fresh execution
      const fresh = yield* Broker.actions.call(service, 'get', undefined)

      return { values, fresh, runs: counter.runs }
    })

    expect(result.values).toEqual(Array.from({ length: 5 }, () => 'value-1'))
    expect(result.fresh).toBe('value-2')
    expect(result.runs).toBe(2)
  })

  it('shares one failure reply between every joiner', async () => {
    const result = await runScoped(function* () {
      const counter = { runs: 0 }
      const service = defineService({
        name: 'coalesced-boom',
        actions: {
          boom: defineAction(function* () {
            counter.runs += 1

            yield* sleep(20)

            return yield* fail('coalesced-boom.boom', 'kaboom')
          }),
        },
      })

      yield* bootstrap()
      yield* install(BucketPolicy, {})
      yield* Broker.actions.register(service)

      const tasks: Task<Reply>[] = []

      for (let index = 0; index < 3; index += 1) {
        tasks.push(yield* spawn(() => Broker.actions.exchange(service, 'boom', undefined)))
      }

      const replies: Reply[] = []

      for (const task of tasks) {
        replies.push(yield* task)
      }

      return { replies, runs: counter.runs }
    })

    expect(result.runs).toBe(1)
    expect(result.replies).toHaveLength(3)

    for (const reply of result.replies) {
      expect(reply.kind).toBe('failure')

      if (reply.kind === 'failure') {
        expect(reply.failure.error).toBe('coalesced-boom.boom')
      }
    }
  })
})
