import { Broker, defineAction, defineService } from 'server:core'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { Metrics } from 'server:plugin/metrics'
import { MemoryMetricsStore } from 'server:plugin/metrics/memory'

import { bootstrap } from '../core/helpers'
import { runScoped } from '../helpers'

const makeDemo = () =>
  defineService({
    name: 'demo',
    version: '1.0.0',
    actions: {
      ok: defineAction(function* () {
        return 'fine'
      }),
    },
  })

describe('Metrics.observe', () => {
  it('times a protocol handle action into the events table', async () => {
    const events = await runScoped(function* () {
      yield* bootstrap()
      yield* install(MemoryMetricsStore)
      yield* install(Metrics, { flushIntervalMs: 60_000 })

      const demo = makeDemo()

      yield* Broker.actions.register(demo)
      yield* Metrics.actions.observe([{ api: Broker, name: 'broker', actions: ['call'] }])
      yield* Broker.actions.call(demo, 'ok', undefined)
      yield* Metrics.actions.flush()

      return yield* Metrics.actions.query({ table: 'events', where: { name: 'broker.call' } })
    })

    expect(events).toHaveLength(1)
    expect(events[0]!.name).toBe('broker.call')
    expect(typeof events[0]!.value).toBe('number')
    expect(events[0]!.value as number).toBeGreaterThanOrEqual(0)
  })

  it('only wraps the listed actions', async () => {
    const events = await runScoped(function* () {
      yield* bootstrap()
      yield* install(MemoryMetricsStore)
      yield* install(Metrics, { flushIntervalMs: 60_000 })

      const demo = makeDemo()

      yield* Metrics.actions.observe([{ api: Broker, name: 'broker', actions: ['call'] }])

      // register/getServices are Broker dispatches too — but not observed
      yield* Broker.actions.register(demo)
      yield* Broker.actions.getServices()
      yield* Broker.actions.call(demo, 'ok', undefined)
      yield* Broker.actions.call(demo, 'ok', undefined)
      yield* Metrics.actions.flush()

      return yield* Metrics.actions.query({ table: 'events' })
    })

    expect(events).toHaveLength(2)
    expect(events.every(event => event.name === 'broker.call')).toBe(true)
  })
})
