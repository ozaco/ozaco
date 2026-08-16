import { MetricsStore } from 'server:core'
import { sleep } from 'std:effect'
import type { Operation } from 'std:effect'
import { FetchClient } from 'std:fetch'
import { install } from 'std:plugin'

import { describe, expect, it } from 'bun:test'

import { StarRocksMetricsStore } from 'server:plugin/metrics/starrocks'
import { JsonCodec } from 'std:codec/impl/json'

import { runScoped } from '../helpers'

const feUrl = process.env.SERVER_TEST_STARROCKS_FE
const queryUrl = process.env.SERVER_TEST_STARROCKS_QUERY
const beUrl = process.env.SERVER_TEST_STARROCKS_BE

/** One database per test-file run so reruns against a long-lived cluster never collide. */
const database = `ozaco_e2e_${Date.now().toString(36)}`

function* setup(): Operation<void> {
  yield* install(JsonCodec)
  yield* install(FetchClient)
  yield* install(StarRocksMetricsStore, { feUrl: feUrl!, queryUrl, beUrl, database })
  yield* MetricsStore.actions.init()
}

describe.skipIf(!feUrl)('StarRocksMetricsStore (docker-gated)', () => {
  it('init → insert → query → prune → sql round trip', async () => {
    const outcome = await runScoped(function* () {
      yield* setup()

      const now = Date.now()

      yield* MetricsStore.actions.insert('events', [
        { ts: now - 120_000, name: 'old', value: 1, meta: null },
        { ts: now, name: 'fresh', value: 2, meta: JSON.stringify({ a: 1 }) },
      ])

      // Stream Load answered Success — poll briefly for publish visibility
      let rows: readonly Record<string, unknown>[] = []

      for (let attempt = 0; attempt < 40 && rows.length < 2; attempt += 1) {
        rows = yield* MetricsStore.actions.query({ table: 'events', sinceMs: now - 300_000 })

        if (rows.length < 2) {
          yield* sleep(250)
        }
      }

      const ordered = yield* MetricsStore.actions.query({
        table: 'events',
        orderBy: 'ts',
        direction: 'desc',
        limit: 1,
      })
      const filtered = yield* MetricsStore.actions.query({
        table: 'events',
        where: { name: 'fresh' },
      })
      const pruned = yield* MetricsStore.actions.prune({ table: 'events', olderThanMs: 60_000 })
      const after = yield* MetricsStore.actions.query({ table: 'events' })
      const raw = yield* MetricsStore.actions.sql('SELECT 1 AS one')

      return { rows, ordered, filtered, pruned, after, raw }
    })

    expect(outcome.rows).toHaveLength(2)
    expect(outcome.ordered).toHaveLength(1)
    expect(String(outcome.ordered[0]!.name)).toBe('fresh')
    expect(outcome.filtered).toHaveLength(1)
    expect(Number(outcome.filtered[0]!.value)).toBe(2)
    expect(Number(outcome.pruned)).toBeGreaterThanOrEqual(1)
    expect(outcome.after.map(row => String(row.name))).not.toContain('old')
    expect(Number(outcome.raw[0]!.one)).toBe(1)
  }, 180_000)

  it('define creates a queryable custom table', async () => {
    const rows = await runScoped(function* () {
      yield* setup()

      yield* MetricsStore.actions.define({
        table: 'deploys',
        columns: [
          { name: 'ts', kind: 'timestamp' },
          { name: 'app', kind: 'text' },
          { name: 'ok', kind: 'boolean' },
          { name: 'tookMs', kind: 'float' },
        ],
      })

      const now = Date.now()

      yield* MetricsStore.actions.insert('deploys', [
        { ts: now, app: 'web', ok: true, tookMs: 12.5 },
      ])

      let found: readonly Record<string, unknown>[] = []

      for (let attempt = 0; attempt < 40 && found.length === 0; attempt += 1) {
        found = yield* MetricsStore.actions.query({ table: 'deploys', where: { app: 'web' } })

        if (found.length === 0) {
          yield* sleep(250)
        }
      }

      // best-effort cleanup for long-lived clusters, then release the pool
      yield* MetricsStore.actions.sql(`DROP DATABASE IF EXISTS \`${database}\``)
      yield* MetricsStore.actions.close()

      return found
    })

    expect(rows).toHaveLength(1)
    expect(String(rows[0]!.app)).toBe('web')
    expect(Number(rows[0]!.tookMs)).toBeCloseTo(12.5)
  }, 180_000)
})
