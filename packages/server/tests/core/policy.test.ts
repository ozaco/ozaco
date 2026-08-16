import { Broker, defineAction, definePolicy, defineService } from 'server:core'
import type { Reply } from 'server:core'
import { scoped } from 'std:effect'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { runScoped } from '../helpers'

import { bootstrap } from './helpers'

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

describe('policy onion', () => {
  it('lowest priority is outermost; layers wrap in order', async () => {
    const order: string[] = []

    await runScoped(function* () {
      const service = defineService({
        name: 'svc',
        actions: {
          run: defineAction(function* () {
            order.push('handler')

            return 1
          }),
        },
      })

      yield* bootstrap()
      yield* install(probe(order, 'outer', 0))
      yield* install(probe(order, 'inner', 60))
      yield* Broker.actions.register(service)
      yield* Broker.actions.call(service, 'run', undefined)
    })

    expect(order).toEqual(['outer:before', 'inner:before', 'handler', 'inner:after', 'outer:after'])
  })

  it('action-level `false` removes a layer; overrides reach the policy', async () => {
    const order: string[] = []
    const overrides: unknown[] = []

    await runScoped(function* () {
      const spy = definePolicy<void, void>({
        name: 'spy',
        priority: 10,
        *setup() {},
        *apply({ override, next }) {
          overrides.push(override)

          return yield* next()
        },
      })

      const service = defineService({
        name: 'svc',
        actions: {
          plain: defineAction(function* () {
            return 1
          }),
          tuned: defineAction({ policies: { spy: { limit: 3 } } }, function* () {
            return 2
          }),
          off: defineAction({ policies: { spy: false, outer: false } }, function* () {
            order.push('off-handler')

            return 3
          }),
        },
      })

      yield* bootstrap()
      yield* install(probe(order, 'outer', 0))
      yield* install(spy)
      yield* Broker.actions.register(service)

      yield* Broker.actions.call(service, 'plain', undefined)
      yield* Broker.actions.call(service, 'tuned', undefined)
      yield* Broker.actions.call(service, 'off', undefined)
    })

    expect(overrides).toEqual([undefined, { limit: 3 }])
    expect(order.filter(entry => entry === 'off-handler')).toEqual(['off-handler'])
    expect(order.filter(entry => entry.startsWith('outer'))).toHaveLength(4)
  })

  it('a policy can short-circuit without dispatching', async () => {
    const result = await runScoped(function* () {
      let handlerRuns = 0

      const shortCircuit = definePolicy<void, void>({
        name: 'short',
        priority: 0,
        *setup() {},
        *apply({ ctx, next }) {
          if (ctx.request.action === 'cached') {
            const reply: Reply = {
              kind: 'value',
              cid: ctx.request.cid,
              meta: {},
              value: 'from-cache',
            }

            return reply
          }

          return yield* next()
        },
      })

      const service = defineService({
        name: 'svc',
        actions: {
          cached: defineAction(function* () {
            handlerRuns += 1

            return 'from-handler'
          }),
        },
      })

      yield* bootstrap()
      yield* install(shortCircuit)
      yield* Broker.actions.register(service)

      const value = yield* Broker.actions.call(service, 'cached', undefined)

      return { value, handlerRuns }
    })

    expect(result.value).toBe('from-cache')
    expect(result.handlerRuns).toBe(0)
  })

  it('scope teardown unregisters the layer', async () => {
    const order: string[] = []

    await runScoped(function* () {
      const service = defineService({
        name: 'svc',
        actions: {
          run: defineAction(function* () {
            return 1
          }),
        },
      })

      yield* bootstrap()
      yield* Broker.actions.register(service)

      yield* scoped(function* () {
        yield* install(probe(order, 'temp', 5))
        yield* Broker.actions.call(service, 'run', undefined)
      })

      yield* Broker.actions.call(service, 'run', undefined)
    })

    expect(order).toEqual(['temp:before', 'temp:after'])
  })
})
