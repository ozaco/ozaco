import { describe, expect, it } from 'bun:test'

import { Broker, DefaultBroker, defineAction, defineService } from '@ozaco/server/core'
import type { MetricsDef } from '@ozaco/server/metrics'
import { Metrics, MetricsCollector, MetricsSink } from '@ozaco/server/metrics'
import { attempt, operation, run, sleep } from '@ozaco/std/effect'
import { BunIO } from '@ozaco/std/io/impl/bun'
import { DefaultLogger, LogLevel } from '@ozaco/std/logger'
import { install } from '@ozaco/std/plugin'
import { fail, isSuccess } from '@ozaco/std/result'

import { call } from './helpers'

const buildDummy = (name: string) =>
  defineService({
    name,
    version: '0.0.0',
    actions: {
      ping: defineAction(function* () {
        return { ok: true }
      }),
    },
    *setup() {},
  })

describe('metrics sink', () => {
  it('store mode records local calls and accepts remote batches via the sink service', async () => {
    const dummy = buildDummy('metrics-dummy-store')
    const result = await run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(DefaultBroker)
      yield* install(MetricsCollector, { path: ':memory:', logs: false })
      yield* dummy.actions.install()
      yield* MetricsSink.actions.install()
      yield* Broker.actions.register(dummy)
      yield* Broker.actions.register(MetricsSink)
      yield* Broker.actions.start()

      for (let i = 0; i < 3; i += 1) {
        yield* call(dummy, 'ping')
      }
      // what a forward-mode pod would ship: a pre-serialized batch, ingested by broker address
      yield* call('metrics-sink', 'ingest', {
        calls: [
          {
            ts: Date.now(),
            service: 'remote-pod',
            action: 'work',
            status: 'success',
            durationMs: 2,
            error: null,
            meta: null,
          },
        ],
        logs: [],
        events: [],
      })
      return yield* Metrics.actions.query(
        'SELECT "service", count(*) AS n FROM calls GROUP BY "service"',
      )
    })

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      const byService = Object.fromEntries(
        result.value.map(row => [String(row.service), Number(row.n)]),
      )
      expect(byService['metrics-dummy-store']).toBe(3)
      expect(byService['remote-pod']).toBe(1)
      // the sink's own traffic must NOT be instrumented — no self-echo rows
      expect(byService['metrics-sink']).toBeUndefined()
    }
  })

  it('forward mode ships batches to the sink service and delegates reads', async () => {
    const received: MetricsDef.IngestBatch[] = []
    // stands in for the storing process: same address, capture instead of DuckDB
    const sinkStub = defineService({
      name: 'metrics-sink',
      version: '0.0.0',
      actions: {
        ingest: defineAction(function* (batch: MetricsDef.IngestBatch) {
          received.push(batch)
        }),
        query: defineAction(function* (spec: MetricsDef.QuerySpec) {
          return [{ echoed: spec.sql }]
        }),
      },
      *setup() {},
    })
    const dummy = buildDummy('metrics-dummy-forward')

    const result = await run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(DefaultBroker)
      yield* install(MetricsCollector, { sink: 'forward', logs: false })
      yield* dummy.actions.install()
      yield* sinkStub.actions.install()
      yield* Broker.actions.register(dummy)
      yield* Broker.actions.register(sinkStub)
      yield* Broker.actions.start()

      yield* call(dummy, 'ping')
      yield* call(dummy, 'ping')
      // flushes the buffered calls to the sink, then delegates the read to it
      return yield* Metrics.actions.query('SELECT 1')
    })

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(result.value).toEqual([{ echoed: 'SELECT 1' }])
    }
    const shipped = received.flatMap(batch => batch.calls)
    expect(shipped.filter(row => row.service === 'metrics-dummy-forward').length).toBe(2)
    // neither the ingest shipping nor the delegated query may instrument itself
    expect(shipped.some(row => row.service === 'metrics-sink')).toBe(false)
  })

  it('a failing store insert drops the batch — the flush loop survives to flush the next one', async () => {
    let broken = true
    const inserted: MetricsDef.StoredCall[] = []
    // no `export`/`import` on purpose: the pair is optional for pluggable stores
    const store: MetricsDef.Store = {
      init: operation(function* () {}),
      insertCalls: operation(function* (rows: readonly MetricsDef.StoredCall[]) {
        if (broken) {
          return yield* fail('unexpected', 'store gone')
        }
        inserted.push(...rows)
      }),
      insertLogs: operation(function* () {}),
      insertEvents: operation(function* () {}),
      define: operation(function* () {}),
      insertRow: operation(function* () {}),
      query: operation(function* () {
        return [] as MetricsDef.Row[]
      }),
      prune: operation(function* () {
        return 0
      }),
      close: operation(function* () {}),
    }
    const dummy = buildDummy('metrics-dummy-broken-store')

    const result = await run(function* () {
      yield* install(BunIO)
      yield* install(DefaultLogger, { level: LogLevel.silent })
      yield* install(DefaultBroker)
      yield* install(MetricsCollector, { store, flushIntervalMs: 10, logs: false })
      yield* dummy.actions.install()
      yield* Broker.actions.register(dummy)
      yield* Broker.actions.start()

      yield* call(dummy, 'ping')
      // several intervals with the store down: the batch is dropped, the loop must not die with it
      yield* sleep(50)
      broken = false
      yield* call(dummy, 'ping')
      yield* sleep(50)

      // a store without `export` answers as unsupported instead of exploding on a missing method
      return yield* attempt(Metrics.actions.export({ table: 'calls', path: '/dev/null' }))
    })

    expect(isSuccess(result)).toBe(true)
    if (isSuccess(result)) {
      expect(isSuccess(result.value)).toBe(false)
    }
    // the post-recovery call flushed — proof the loop outlived the failure; the failed batch stayed dropped
    expect(inserted.length).toBe(1)
  })
})
