import { CoreErrors, MetricsStore } from 'server:core'
import { install } from 'std:plugin'
import { isFailure } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { MemoryMetricsStore } from 'server:plugin/metrics/memory'

import { runResult, runScoped } from '../helpers'

const seed = [
  { ts: 1000, service: 'todos', action: 'get', durationMs: 5 },
  { ts: 2000, service: 'todos', action: 'list', durationMs: 9 },
  { ts: 3000, service: 'ai', action: 'chat', durationMs: 40 },
]

describe('MemoryMetricsStore', () => {
  it('init is a no-op and insert/query round trips', async () => {
    const rows = await runScoped(function* () {
      yield* install(MemoryMetricsStore)
      yield* MetricsStore.actions.init()
      yield* MetricsStore.actions.insert('calls', seed)

      return yield* MetricsStore.actions.query({ table: 'calls' })
    })

    expect(rows).toHaveLength(3)
    expect(rows.map(row => row.action)).toEqual(['get', 'list', 'chat'])
  })

  it('query filters by where equality', async () => {
    const rows = await runScoped(function* () {
      yield* install(MemoryMetricsStore)
      yield* MetricsStore.actions.insert('calls', seed)

      return yield* MetricsStore.actions.query({ table: 'calls', where: { service: 'todos' } })
    })

    expect(rows).toHaveLength(2)
    expect(rows.every(row => row.service === 'todos')).toBe(true)
  })

  it('query filters by sinceMs/untilMs against the ts column (inclusive)', async () => {
    const rows = await runScoped(function* () {
      yield* install(MemoryMetricsStore)
      yield* MetricsStore.actions.insert('calls', seed)

      return yield* MetricsStore.actions.query({ table: 'calls', sinceMs: 2000, untilMs: 3000 })
    })

    expect(rows.map(row => row.ts)).toEqual([2000, 3000])
  })

  it('query orders and limits', async () => {
    const outcome = await runScoped(function* () {
      yield* install(MemoryMetricsStore)
      yield* MetricsStore.actions.insert('calls', seed)

      const desc = yield* MetricsStore.actions.query({
        table: 'calls',
        orderBy: 'durationMs',
        direction: 'desc',
      })
      const top = yield* MetricsStore.actions.query({
        table: 'calls',
        orderBy: 'ts',
        direction: 'asc',
        limit: 2,
      })

      return { desc, top }
    })

    expect(outcome.desc.map(row => row.durationMs)).toEqual([40, 9, 5])
    expect(outcome.top.map(row => row.ts)).toEqual([1000, 2000])
  })

  it('querying an unknown table returns no rows', async () => {
    const rows = await runScoped(function* () {
      yield* install(MemoryMetricsStore)

      return yield* MetricsStore.actions.query({ table: 'ghosts' })
    })

    expect(rows).toEqual([])
  })

  it('define registers a table; prune removes old rows and returns the count', async () => {
    const outcome = await runScoped(function* () {
      yield* install(MemoryMetricsStore)
      yield* MetricsStore.actions.define({
        table: 'deploys',
        columns: [
          { name: 'ts', kind: 'timestamp' },
          { name: 'app', kind: 'text' },
        ],
      })

      const empty = yield* MetricsStore.actions.query({ table: 'deploys' })
      const now = Date.now()

      yield* MetricsStore.actions.insert('deploys', [
        { ts: now - 100_000, app: 'old' },
        { ts: now - 90_000, app: 'older' },
        { ts: now, app: 'fresh' },
      ])

      const pruned = yield* MetricsStore.actions.prune({ table: 'deploys', olderThanMs: 50_000 })
      const left = yield* MetricsStore.actions.query({ table: 'deploys' })

      return { empty, pruned, left }
    })

    expect(outcome.empty).toEqual([])
    expect(outcome.pruned).toBe(2)
    expect(outcome.left.map(row => row.app)).toEqual(['fresh'])
  })

  it('prune on an unknown table removes nothing', async () => {
    const pruned = await runScoped(function* () {
      yield* install(MemoryMetricsStore)

      return yield* MetricsStore.actions.prune({ table: 'ghosts', olderThanMs: 1000 })
    })

    expect(pruned).toBe(0)
  })

  it('sql fails unsupported', async () => {
    const outcome = await runResult(function* () {
      yield* install(MemoryMetricsStore)

      return yield* MetricsStore.actions.sql('SELECT 1')
    })

    expect(isFailure(outcome)).toBe(true)

    if (isFailure(outcome)) {
      expect(outcome.error).toBe(CoreErrors.Unsupported)
    }
  })

  it('close clears every table', async () => {
    const rows = await runScoped(function* () {
      yield* install(MemoryMetricsStore)
      yield* MetricsStore.actions.insert('calls', seed)
      yield* MetricsStore.actions.close()

      return yield* MetricsStore.actions.query({ table: 'calls' })
    })

    expect(rows).toEqual([])
  })
})
