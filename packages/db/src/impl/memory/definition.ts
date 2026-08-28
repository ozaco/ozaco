import type { Adapter, Spec } from 'db:core'
import { DbAdapter, DbErrors } from 'db:core'
import { adapterDefaults, matches, sortDocs } from 'db:internal'
import type { Operation } from 'std:effect'
import { attempt, useContext } from 'std:effect'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import pkg from '../../../package.json'

import {
  aggregateDocs,
  applySteps,
  checkUnique,
  clone,
  filtered,
  keyOf,
  project,
  restore,
  snapshotOf,
  StateRef,
  tableOf,
} from './internal'
import type { Memory } from './types'

/**
 * The zero-dependency in-memory adapter — the reference `DbAdapter` implementation and the
 * natural test/dev backend. Supports transactions (snapshot/restore, nestable) and unique
 * indexes; no raw statements.
 */
export const MemoryAdapter = DbAdapter.implement<Adapter.Options, []>({
  name: 'memory',
  version: pkg.version,
  description: 'In-memory reference adapter',

  *setup() {
    const state: Memory.State = { tables: new Map(), shapes: new Map(), indexes: new Map() }
    yield* StateRef.set(state)
    return {
      adapter: 'memory',
      capabilities: { transactions: true, raw: false, alterColumn: false },
    }
  },
}).build({
  ...adapterDefaults('memory'),

  *find(spec: Spec.Find) {
    const state = yield* useContext(StateRef)
    const rows = sortDocs(yield* filtered(state, spec), spec.order)
    const start = spec.offset ?? 0
    const end = spec.limit === null ? undefined : start + Math.max(0, Math.trunc(spec.limit))
    const window = rows.slice(start, end)

    return spec.fields ? window.map(row => project(row, spec.fields!)) : window.map(clone)
  },

  *count(spec: Spec.Count) {
    const state = yield* useContext(StateRef)
    return (yield* filtered(state, spec)).length
  },

  *aggregate(spec: Spec.Aggregate) {
    const state = yield* useContext(StateRef)
    return aggregateDocs(yield* filtered(state, spec), spec)
  },

  *insert(table: Spec.Table, rows: readonly Spec.Doc[]) {
    const state = yield* useContext(StateRef)
    const target = yield* tableOf(state, table.name)
    const key = keyOf(table)
    const stored: Spec.Doc[] = []
    for (const row of rows) {
      const id = String(row[key])
      if (target.has(id)) {
        return yield* fail(DbErrors.Unique, `duplicate ${key} "${id}" in "${table.name}"`)
      }
      const candidate = clone(row)
      yield* checkUnique(state, table, candidate)
      target.set(id, candidate)
      stored.push(clone(candidate))
    }
    return stored
  },

  *update(spec: Spec.Update) {
    const state = yield* useContext(StateRef)
    const target = yield* tableOf(state, spec.table.name)
    const updated: Spec.Doc[] = []
    for (const [id, doc] of target) {
      if (spec.filter && !matches(doc, spec.filter)) {
        continue
      }
      const next: Spec.Doc = { ...doc, ...spec.set }
      yield* checkUnique(state, spec.table, next)
      target.set(id, next)
      updated.push(clone(next))
    }
    return updated
  },

  *remove(spec: Spec.Delete) {
    const state = yield* useContext(StateRef)
    const target = yield* tableOf(state, spec.table.name)
    const removed: Spec.Doc[] = []
    for (const [id, doc] of target) {
      if (spec.filter && !matches(doc, spec.filter)) {
        continue
      }
      target.delete(id)
      removed.push(clone(doc))
    }
    return removed
  },

  *introspect(table: Spec.Table) {
    const state = yield* useContext(StateRef)
    const shape = state.shapes.get(table.name)
    if (!shape) {
      return null
    }
    const declared = new Map(table.columns.map(column => [column.name, column.kind]))
    return {
      columns: [...shape].map(([name, kind]) => ({
        name,
        type: kind,
        expected: declared.get(name) ?? null,
      })),
    }
  },

  *tables() {
    return [...(yield* useContext(StateRef)).tables.keys()]
  },

  *migrate(steps: readonly Spec.Step[]) {
    applySteps(yield* useContext(StateRef), steps)
  },

  // snapshot/restore: nested calls simply snapshot again, so an inner failure rewinds to its own
  // entry point while the outer transaction stays open
  *transaction(body: () => Operation<unknown>) {
    const state = yield* useContext(StateRef)
    const snapshot = snapshotOf(state)
    const outcome = yield* attempt(body)
    if (isFailure(outcome)) {
      restore(state, snapshot)
      return yield* outcome
    }
    return outcome.value as AnyType
  },
})
