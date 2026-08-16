import { Broker, CoreErrors, defineAction, defineService, MetricsStore } from 'server:core'
import { attempt, scoped, sleep } from 'std:effect'
import { install } from 'std:plugin'
import { fail, isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { Metrics } from 'server:plugin/metrics'
import { MemoryMetricsStore } from 'server:plugin/metrics/memory'

import { bootstrap } from '../core/helpers'
import { runResult, runScoped } from '../helpers'

const DemoErrors = { Boom: 'demo.boom' } as const

const makeDemo = () =>
  defineService({
    name: 'demo',
    version: '1.0.0',
    actions: {
      ok: defineAction(function* () {
        return 'fine'
      }),
      boom: defineAction({ errors: { [DemoErrors.Boom]: 500 } }, function* () {
        return yield* fail(DemoErrors.Boom, 'kaboom')
      }),
    },
  })

describe('Metrics collector', () => {
  it('fails configuration when no store is installed', async () => {
    const outcome = await runResult(function* () {
      yield* bootstrap()
      yield* install(Metrics)
    })

    expect(isFailure(outcome)).toBe(true)

    if (isFailure(outcome)) {
      expect(outcome.error).toBe(CoreErrors.Configuration)
    }
  })

  it('records every dispatch with the full correlation spine', async () => {
    const rows = await runScoped(function* () {
      yield* bootstrap()
      yield* install(MemoryMetricsStore)
      yield* install(Metrics, { flushIntervalMs: 20, fields: () => ({ tenant: 'acme' }) })

      const demo = makeDemo()

      yield* Broker.actions.register(demo)
      yield* Broker.actions.call(demo, 'ok', undefined)
      yield* attempt(() => Broker.actions.call(demo, 'boom', undefined))
      yield* Metrics.actions.flush()

      return yield* Metrics.actions.query({ table: 'calls' })
    })

    expect(rows).toHaveLength(2)

    const ok = rows.find(row => row.action === 'ok')!
    const boom = rows.find(row => row.action === 'boom')!

    expect(ok.status).toBe('success')
    expect(ok.outcome).toBe('fulfilled')
    expect(ok.delivered).toBe(true)
    expect(String(ok.requestId)).toMatch(/^r_/u)
    expect(String(ok.actionId)).toMatch(/^a_/u)
    expect(ok.laneId).toBe('demo')
    expect(typeof ok.durationMs).toBe('number')
    expect(JSON.parse(String(ok.meta))).toEqual({ tenant: 'acme' })

    expect(boom.status).toBe('failure')
    expect(boom.outcome).toBe('failed')
    // the handler failure was folded into a failure REPLY and delivered to the caller
    expect(boom.delivered).toBe(true)
    expect(boom.error).toBe(DemoErrors.Boom)
    expect(typeof boom.causes).toBe('string')

    const causes = JSON.parse(String(boom.causes)) as string[]

    expect(Array.isArray(causes)).toBe(true)
    expect(causes.join(' | ')).toContain('action:boom(')
  })

  it('the interval pump flushes without an explicit flush()', async () => {
    const rows = await runScoped(function* () {
      yield* bootstrap()
      yield* install(MemoryMetricsStore)
      yield* install(Metrics, { flushIntervalMs: 20 })

      const demo = makeDemo()

      yield* Broker.actions.register(demo)
      yield* Broker.actions.call(demo, 'ok', undefined)
      yield* sleep(80)

      return yield* Metrics.actions.query({ table: 'calls' })
    })

    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('ok')
  })

  it('record() lands custom rows in the events table', async () => {
    const events = await runScoped(function* () {
      yield* bootstrap()
      yield* install(MemoryMetricsStore)
      yield* install(Metrics, { flushIntervalMs: 60_000 })

      yield* Metrics.actions.record('cache.hit', 1, { region: 'eu' })
      yield* Metrics.actions.record('cache.miss')
      yield* Metrics.actions.flush()

      return yield* Metrics.actions.query({ table: 'events', orderBy: 'name', direction: 'asc' })
    })

    expect(events).toHaveLength(2)
    expect(events[0]!.name).toBe('cache.hit')
    expect(events[0]!.value).toBe(1)
    expect(JSON.parse(String(events[0]!.meta))).toEqual({ region: 'eu' })
    expect(events[1]!.name).toBe('cache.miss')
    expect(events[1]!.value).toBeUndefined()
  })

  it('scope teardown runs a final flush before releasing the store', async () => {
    const inserted: Record<string, number> = {}

    await runScoped(function* () {
      yield* bootstrap()
      yield* install(MemoryMetricsStore)
      yield* MetricsStore.around({
        *insert([table, rows], next) {
          inserted[table] = (inserted[table] ?? 0) + rows.length

          return yield* next(table, rows)
        },
      })

      const demo = makeDemo()

      yield* Broker.actions.register(demo)

      // the store outlives the collector: Metrics lives in an inner scope, no explicit flush —
      // the buffered call row must be flushed by the teardown ensure
      yield* scoped(function* () {
        yield* install(Metrics, { flushIntervalMs: 60_000, captureLogs: false })
        yield* Broker.actions.call(demo, 'ok', undefined)
      })
    })

    expect(inserted.calls).toBe(1)
  })
})
