import { CoreErrors, MetricsStore } from 'server:core'
import type { MetricsStoreDef } from 'server:core'
import { moduleLogger } from 'server:utils'
import { operation, useContext } from 'std:effect'
import { fail } from 'std:result'

import type { MemoryStore } from './types'

const MemoryMetricsStoreImpl = MetricsStore.implement<MemoryStore.Context, []>({
  name: 'memory-metrics-store',
  version: '0.1.0',
  *setup() {
    const log = yield* moduleLogger('server:metrics/memory')

    return { tables: new Map<string, MetricsStoreDef.Row[]>(), log }
  },
})

const useStore = () => useContext(MemoryMetricsStoreImpl.context)

const matches =
  (spec: MetricsStoreDef.QuerySpec) =>
  (row: MetricsStoreDef.Row): boolean => {
    if (spec.where) {
      for (const [key, value] of Object.entries(spec.where)) {
        if (row[key] !== value) {
          return false
        }
      }
    }

    if (spec.sinceMs !== undefined || spec.untilMs !== undefined) {
      const ts = row.ts

      if (typeof ts !== 'number') {
        return false
      }

      if (spec.sinceMs !== undefined && ts < spec.sinceMs) {
        return false
      }

      if (spec.untilMs !== undefined && ts > spec.untilMs) {
        return false
      }
    }

    return true
  }

const compareValues = (left: unknown, right: unknown): number => {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right
  }

  const a = String(left)
  const b = String(right)

  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * The in-memory `MetricsStore` — the reference (and test) implementation. Tables live in the
 * setup-returned context; the structured query spec is fully supported, the raw `sql` escape hatch
 * deliberately is not.
 */
export const MemoryMetricsStore = MemoryMetricsStoreImpl.build({
  init: operation(function* () {
    yield* useStore()
  }),

  insert: operation(function* (table: string, rows: readonly MetricsStoreDef.Row[]) {
    const ctx = yield* useStore()
    const bucket = ctx.tables.get(table)

    if (bucket) {
      bucket.push(...rows)
    } else {
      ctx.tables.set(table, [...rows])
    }
  }),

  query: operation(function* (spec: MetricsStoreDef.QuerySpec) {
    const ctx = yield* useStore()
    const rows = (ctx.tables.get(spec.table) ?? []).filter(matches(spec))

    const ordered = spec.orderBy
      ? rows.toSorted((a, b) => {
          const order = compareValues(a[spec.orderBy!], b[spec.orderBy!])

          return spec.direction === 'desc' ? -order : order
        })
      : rows

    // the returned array is always fresh (filter/toSorted/slice) — rows stay shared references
    return (
      spec.limit === undefined ? ordered : ordered.slice(0, spec.limit)
    ) as readonly MetricsStoreDef.Row[]
  }),

  sql: operation(function* (_statement: string, _params?: readonly unknown[]) {
    return yield* fail(
      CoreErrors.Unsupported,
      'the memory metrics store has no SQL surface — use the structured query(spec)',
    )
  }),

  define: operation(function* (spec: MetricsStoreDef.DefineSpec) {
    const ctx = yield* useStore()

    if (!ctx.tables.has(spec.table)) {
      ctx.tables.set(spec.table, [])
    }
  }),

  prune: operation(function* (spec: MetricsStoreDef.PruneSpec) {
    const ctx = yield* useStore()
    const bucket = ctx.tables.get(spec.table)

    if (!bucket) {
      return 0
    }

    const cutoff = Date.now() - spec.olderThanMs
    const kept = bucket.filter(row => !(typeof row.ts === 'number' && row.ts < cutoff))
    const removed = bucket.length - kept.length

    ctx.tables.set(spec.table, kept)

    return removed
  }),

  close: operation(function* () {
    const ctx = yield* useStore()

    ctx.tables.clear()
  }),
})
