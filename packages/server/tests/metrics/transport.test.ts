import { Broker, DefaultBroker, defineAction, defineService, useLog } from 'server:core'
import { DefaultLogger, LogLevel } from 'std:logger'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { Metrics } from 'server:plugin/metrics'
import { MemoryMetricsStore } from 'server:plugin/metrics/memory'
import { BunIO } from 'std:io/impl/bun'

import { runScoped } from '../helpers'

const makeNoisy = () =>
  defineService({
    name: 'noisy',
    version: '1.0.0',
    actions: {
      speak: defineAction(function* () {
        const log = yield* useLog()

        yield* log.info('quiet', {})
        yield* log.warn('careful', { hint: 'x' })
        yield* log.error('kaboom', {})

        return 'ok'
      }),
    },
  })

/** Like `bootstrap()`, but the logger actually dispatches entries (bootstrap pins `silent`). */
function* loudBootstrap() {
  yield* install(BunIO)
  yield* install(DefaultLogger, { level: LogLevel.trace })
  yield* install(DefaultBroker)
  yield* Broker.actions.start()
}

describe('MetricsLogTransport', () => {
  it('captures warn+ entries with the correlation bindings; info stays below the floor', async () => {
    const rows = await runScoped(function* () {
      yield* loudBootstrap()
      yield* install(MemoryMetricsStore)
      yield* install(Metrics, { flushIntervalMs: 60_000 })

      const noisy = makeNoisy()

      yield* Broker.actions.register(noisy)
      yield* Broker.actions.call(noisy, 'speak', undefined)
      yield* Metrics.actions.flush()

      return yield* Metrics.actions.query({ table: 'logs' })
    })

    const messages = rows.map(row => row.msg)

    expect(messages).toContain('careful')
    expect(messages).toContain('kaboom')
    expect(messages).not.toContain('quiet')

    const warn = rows.find(row => row.msg === 'careful')!

    expect(warn.level).toBe(LogLevel.warn)
    expect(String(warn.requestId)).toMatch(/^r_/u)
    expect(String(warn.serviceId)).toContain('noisy@1.0.0#')
    expect(String(warn.actionId)).toMatch(/^a_/u)
    expect(JSON.parse(String(warn.meta))).toEqual({ hint: 'x' })

    const error = rows.find(row => row.msg === 'kaboom')!

    expect(error.level).toBe(LogLevel.error)
    expect(error.requestId).toBe(warn.requestId)
  })

  it('a custom logLevel floor drops warn entries too', async () => {
    const rows = await runScoped(function* () {
      yield* loudBootstrap()
      yield* install(MemoryMetricsStore)
      yield* install(Metrics, { flushIntervalMs: 60_000, logLevel: LogLevel.error })

      const noisy = makeNoisy()

      yield* Broker.actions.register(noisy)
      yield* Broker.actions.call(noisy, 'speak', undefined)
      yield* Metrics.actions.flush()

      return yield* Metrics.actions.query({ table: 'logs' })
    })

    const messages = rows.map(row => row.msg)

    expect(messages).toContain('kaboom')
    expect(messages).not.toContain('careful')
    expect(messages).not.toContain('quiet')
  })

  it('captureLogs: false installs no transport', async () => {
    const rows = await runScoped(function* () {
      yield* loudBootstrap()
      yield* install(MemoryMetricsStore)
      yield* install(Metrics, { flushIntervalMs: 60_000, captureLogs: false })

      const noisy = makeNoisy()

      yield* Broker.actions.register(noisy)
      yield* Broker.actions.call(noisy, 'speak', undefined)
      yield* Metrics.actions.flush()

      return yield* Metrics.actions.query({ table: 'logs' })
    })

    expect(rows).toEqual([])
  })
})
