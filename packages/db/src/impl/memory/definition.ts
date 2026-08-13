import type {
  AdapterDef,
  CountSpec,
  DeleteSpec,
  Doc,
  FindSpec,
  MigrateStep,
  TableSpec,
  UpdateSpec,
} from 'db:core'
import { adapterDefaults, DbAdapter, DbErrors, ID } from 'db:core'
import { attempt, operation, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { matches, sortRows } from './internal'
import { applySteps } from './migrate'
import type { MemoryState } from './state'
import { checkUnique, clone, filtered, restore, snapshotOf, StateRef, tableOf } from './state'

/**
 * The zero-dependency in-memory adapter — the reference `DbAdapter` implementation and the natural
 * test/dev backend. Supports transactions (snapshot/restore, nestable) and unique indexes; no live
 * feed (local writes drive reactivity) and no raw statements.
 */
export const MemoryAdapter = DbAdapter.implement<AdapterDef.Info, []>({
  name: 'memory',
  version: '0.1.0',
  *setup() {
    const state: MemoryState = { tables: new Map(), shapes: new Map(), indexes: new Map() }
    yield* StateRef.set(state)
    return {
      adapter: 'memory',
      capabilities: { transactions: true, live: false, raw: false },
    }
  },
}).build({
  ...adapterDefaults('memory'),

  find: operation(function* (spec: FindSpec) {
    const state = yield* useContext(StateRef)
    const rows = sortRows(yield* filtered(state, spec), spec.order)
    const start = spec.offset ?? 0
    const end = spec.limit === null ? undefined : start + Math.max(0, Math.trunc(spec.limit))
    return rows.slice(start, end).map(clone)
  }),

  count: operation(function* (spec: CountSpec) {
    const state = yield* useContext(StateRef)
    return (yield* filtered(state, spec)).length
  }),

  insert: operation(function* (table: TableSpec, rows: readonly Doc[]) {
    const state = yield* useContext(StateRef)
    const target = yield* tableOf(state, table.name)
    const stored: Doc[] = []
    for (const row of rows) {
      const id = String(row[ID])
      if (target.has(id)) {
        return yield* fail(DbErrors.Unique, `duplicate _id "${id}" in "${table.name}"`)
      }
      const candidate = clone(row)
      yield* checkUnique(state, table, candidate)
      target.set(id, candidate)
      stored.push(clone(candidate))
    }
    return stored
  }),

  update: operation(function* (spec: UpdateSpec) {
    const state = yield* useContext(StateRef)
    const target = yield* tableOf(state, spec.table.name)
    const updated: Doc[] = []
    for (const [id, doc] of target) {
      if (spec.filter && !matches(doc, spec.filter)) {
        continue
      }
      const next: Doc = { ...doc, ...spec.set }
      for (const column of spec.bump) {
        next[column] = Number(next[column] ?? 0) + 1
      }
      yield* checkUnique(state, spec.table, next)
      target.set(id, next)
      updated.push(clone(next))
    }
    return updated
  }),

  remove: operation(function* (spec: DeleteSpec) {
    const state = yield* useContext(StateRef)
    const target = yield* tableOf(state, spec.table.name)
    const removed: Doc[] = []
    for (const [id, doc] of target) {
      if (spec.filter && !matches(doc, spec.filter)) {
        continue
      }
      target.delete(id)
      removed.push(clone(doc))
    }
    return removed
  }),

  introspect: operation(function* (table: TableSpec) {
    const state = yield* useContext(StateRef)
    const shape = state.shapes.get(table.name)
    return shape ? { columns: [...shape] } : null
  }),

  migrate: operation(function* (steps: readonly MigrateStep[]) {
    const state = yield* useContext(StateRef)
    applySteps(state, steps)
  }),

  transaction: operation(function* (body: () => AnyType) {
    const state = yield* useContext(StateRef)
    const snapshot = snapshotOf(state)
    const outcome = yield* attempt(body())
    if (isFailure(outcome)) {
      restore(state, snapshot)
      return yield* outcome
    }
    return outcome.value as AnyType
  }),
})
