import { Broker, CoreErrors, defineAction, defineService, stream } from 'server:core'
import { sleep } from 'std:effect'
import type { Flow } from 'std:effect'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { TimeoutPolicy } from 'server:policy/timeout'

import { bootstrap } from '../core/helpers'
import { runResult, runScoped } from '../helpers'

/** A minimal in-memory Flow over a fixed item list. */
const flowOf = (items: readonly string[]): Flow<string, void> => ({
  *[Symbol.iterator]() {
    let index = 0

    return {
      next: () => ({
        // eslint-style manual operation: one IteratorResult per pull
        *[Symbol.iterator]() {
          if (index >= items.length) {
            return { done: true, value: undefined } as IteratorResult<string, void>
          }

          const value = items[index] as string

          index += 1

          return { done: false, value } as IteratorResult<string, void>
        },
      }),
    }
  },
})

describe('policy: timeout', () => {
  it('raises TimeoutPending when the per-action override deadline passes', async () => {
    const failure = await runResult(function* () {
      const service = defineService({
        name: 'slow-svc',
        actions: {
          slow: defineAction({ policies: { timeout: { ms: 20 } } }, function* () {
            yield* sleep(200)

            return 'too late'
          }),
        },
      })

      yield* bootstrap()
      yield* install(TimeoutPolicy, {})
      yield* Broker.actions.register(service)

      yield* Broker.actions.call(service, 'slow', undefined)
    })

    expect(isFailure(failure)).toBe(true)

    if (isFailure(failure)) {
      expect(failure.error).toBe(CoreErrors.TimeoutPending)
      expect(failure.message).toBe('policy timeout after 20ms — outcome unknown')
      expect(failure.causes.includes('policy:timeout')).toBe(true)
    }
  })

  it('override false disables the layer for the action', async () => {
    const value = await runScoped(function* () {
      const service = defineService({
        name: 'untimed-svc',
        actions: {
          slow: defineAction({ policies: { timeout: false } }, function* () {
            yield* sleep(50)

            return 'worth the wait'
          }),
        },
      })

      yield* bootstrap()
      yield* install(TimeoutPolicy, { ms: 15 })
      yield* Broker.actions.register(service)

      return yield* Broker.actions.call(service, 'slow', undefined)
    })

    expect(value).toBe('worth the wait')
  })

  it('streaming dispatches skip the layer by default', async () => {
    const collected = await runScoped(function* () {
      const service = defineService({
        name: 'feed-svc',
        actions: {
          feed: defineAction({ output: stream() }, function* () {
            yield* sleep(50)

            return flowOf(['a', 'b'])
          }),
        },
      })

      yield* bootstrap()
      yield* install(TimeoutPolicy, { ms: 10 })
      yield* Broker.actions.register(service)

      const flow = (yield* Broker.actions.call(service, 'feed', undefined)) as Flow<string, void>
      const subscription = yield* flow
      const items: string[] = []

      let result = yield* subscription.next()

      while (!result.done) {
        items.push(result.value)

        result = yield* subscription.next()
      }

      return items
    })

    expect(collected).toEqual(['a', 'b'])
  })

  it('fast dispatches pass through untouched', async () => {
    const value = await runScoped(function* () {
      const service = defineService({
        name: 'quick-svc',
        actions: {
          ping: defineAction(function* () {
            return 'pong'
          }),
        },
      })

      yield* bootstrap()
      yield* install(TimeoutPolicy, { ms: 100 })
      yield* Broker.actions.register(service)

      return yield* Broker.actions.call(service, 'ping', undefined)
    })

    expect(value).toBe('pong')
  })
})
