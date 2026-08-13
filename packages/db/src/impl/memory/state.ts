// oxlint-disable import/exports-last
import type { CountSpec, Doc, FindSpec, IndexSpec, TableSpec } from 'db:core'
import { DbErrors, ID } from 'db:core'
import { createContext, operation } from 'std:effect'
import { fail } from 'std:result'

import { matches, uniqueKey } from './internal'

export interface MemoryState {
  readonly tables: Map<string, Map<string, Doc>>
  readonly shapes: Map<string, Set<string>>
  readonly indexes: Map<string, Map<string, IndexSpec>>
}

export const StateRef = createContext<MemoryState>('db:impl/memory')

export const clone = (doc: Doc): Doc => ({ ...doc })

export const tableOf = operation(function* (state: MemoryState, name: string) {
  const rows = state.tables.get(name)
  if (!rows) {
    return yield* fail(DbErrors.Query, `no such table "${name}"`)
  }
  return rows
})

export const filtered = operation(function* (state: MemoryState, spec: FindSpec | CountSpec) {
  const rows = yield* tableOf(state, spec.table.name)
  const all = [...rows.values()]
  const predicate = spec.filter
  return predicate ? all.filter(doc => matches(doc, predicate)) : all
})

/** Enforce the table's unique indexes for `candidate` against every other row (and `_id` itself). */
export const checkUnique = operation(function* (
  state: MemoryState,
  table: TableSpec,
  candidate: Doc,
) {
  const rows = state.tables.get(table.name) ?? new Map<string, Doc>()
  const declared = [...(state.indexes.get(table.name)?.values() ?? [])].filter(
    index => index.unique,
  )
  for (const index of declared) {
    const key = uniqueKey(index, candidate)
    if (key === null) {
      continue
    }
    for (const other of rows.values()) {
      if (other[ID] === candidate[ID]) {
        continue
      }
      if (uniqueKey(index, other) === key) {
        return yield* fail(
          DbErrors.Unique,
          `unique index "${index.name}" violated on "${table.name}"`,
          `columns=${index.columns.join(',')}`,
        )
      }
    }
  }
})

export const snapshotOf = (state: MemoryState): MemoryState => ({
  tables: new Map(
    [...state.tables].map(([name, rows]) => [
      name,
      new Map([...rows].map(([id, doc]) => [id, clone(doc)])),
    ]),
  ),
  shapes: new Map([...state.shapes].map(([name, columns]) => [name, new Set(columns)])),
  indexes: new Map([...state.indexes].map(([name, defs]) => [name, new Map(defs)])),
})

export const restore = (state: MemoryState, snapshot: MemoryState): void => {
  state.tables.clear()
  for (const [name, rows] of snapshot.tables) {
    state.tables.set(name, rows)
  }
  state.shapes.clear()
  for (const [name, columns] of snapshot.shapes) {
    state.shapes.set(name, columns)
  }
  state.indexes.clear()
  for (const [name, defs] of snapshot.indexes) {
    state.indexes.set(name, defs)
  }
}
