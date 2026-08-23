// oxlint-disable import/exports-last
import type { Spec } from 'db:core'
import { DbErrors, FIELDS, matches, VERSION_ZERO } from 'db:core'
import { createContext } from 'std:effect'
import { fail } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import type { Memory } from './types'

export const StateRef = createContext<Memory.State>('db:impl/memory')

export const clone = (doc: Spec.Doc): Spec.Doc => ({ ...doc })

/** The column rows are keyed by: the table's primary column (`_id` for declared tables, `token`
 * for change logs). */
export const keyOf = (table: Spec.Table): string =>
  table.columns.find(column => column.primary)?.name ?? FIELDS.id

export function* tableOf(state: Memory.State, name: string) {
  const rows = state.tables.get(name)

  if (!rows) {
    return yield* fail(DbErrors.Query, `no such table "${name}"`)
  }

  return rows
}

/** The rows of a table matching a spec's filter (all rows when there is none). */
export function* filtered(state: Memory.State, spec: Spec.Count) {
  const rows = [...(yield* tableOf(state, spec.table.name)).values()]
  const { filter } = spec

  return filter ? rows.filter(doc => matches(doc, filter)) : rows
}

/** The values of a unique index for one row, as a comparable key — null when any part is null
 * (SQL unique indexes admit multiple nulls). */
function* uniqueKey(index: Spec.Index, doc: Spec.Doc) {
  const parts: unknown[] = []

  for (const name of index.columns) {
    const raw = doc[name]

    if (raw === null || raw === undefined) {
      return null
    }

    parts.push(raw instanceof Date ? raw.getTime() : raw)
  }

  return yield* JsonCodec.actions.stringify(parts)
}

/** Enforce the table's unique indexes for `candidate` against every other row. */
export function* checkUnique(state: Memory.State, table: Spec.Table, candidate: Spec.Doc) {
  const rows = state.tables.get(table.name) ?? new Map<string, Spec.Doc>()
  const key = keyOf(table)
  const unique = [...(state.indexes.get(table.name)?.values() ?? [])].filter(index => index.unique)

  for (const index of unique) {
    const fingerprint = yield* uniqueKey(index, candidate)

    if (fingerprint === null) {
      continue
    }

    for (const other of rows.values()) {
      if (other[key] !== candidate[key] && (yield* uniqueKey(index, other)) === fingerprint) {
        return yield* fail(
          DbErrors.Unique,
          `unique index "${index.name}" violated on "${table.name}"`,
          `columns=${index.columns.join(',')}`,
        )
      }
    }
  }
}

/** A deep copy of the state — the transaction rollback point. */
export const snapshotOf = (state: Memory.State): Memory.State => ({
  tables: new Map(
    [...state.tables].map(([name, rows]) => [
      name,
      new Map([...rows].map(([id, doc]) => [id, clone(doc)])),
    ]),
  ),
  shapes: new Map([...state.shapes].map(([name, columns]) => [name, new Map(columns)])),
  indexes: new Map([...state.indexes].map(([name, defs]) => [name, new Map(defs)])),
})

const replaceAll = <K, V>(target: Map<K, V>, source: ReadonlyMap<K, V>): void => {
  target.clear()

  for (const [key, value] of source) {
    target.set(key, value)
  }
}

export const restore = (state: Memory.State, snapshot: Memory.State): void => {
  replaceAll(state.tables, snapshot.tables)
  replaceAll(state.shapes, snapshot.shapes)
  replaceAll(state.indexes, snapshot.indexes)
}

/** Backfill for a column added to existing rows — system columns get their stamp defaults. */
const backfill = (column: Spec.Column): unknown => {
  if (column.name === FIELDS.version) {
    return VERSION_ZERO
  }

  return column.name === FIELDS.created || column.name === FIELDS.updated ? 0 : null
}

/** Apply reconcile steps to the in-memory shapes/tables/indexes. */
export const applySteps = (state: Memory.State, steps: readonly Spec.Step[]): void => {
  for (const step of steps) {
    switch (step.kind) {
      case 'create-table': {
        if (!state.shapes.has(step.table.name)) {
          state.shapes.set(
            step.table.name,
            new Map(step.table.columns.map(column => [column.name, column.kind])),
          )
        }

        if (!state.tables.has(step.table.name)) {
          state.tables.set(step.table.name, new Map())
        }

        break
      }

      case 'add-column': {
        state.shapes.get(step.table)?.set(step.column.name, step.column.kind)

        for (const doc of state.tables.get(step.table)?.values() ?? []) {
          doc[step.column.name] = backfill(step.column)
        }

        break
      }

      case 'drop-column': {
        state.shapes.get(step.table)?.delete(step.column)

        for (const doc of state.tables.get(step.table)?.values() ?? []) {
          Reflect.deleteProperty(doc, step.column)
        }

        break
      }

      case 'create-index': {
        const declared = state.indexes.get(step.table) ?? new Map<string, Spec.Index>()
        declared.set(step.index.name, step.index)
        state.indexes.set(step.table, declared)
        break
      }

      case 'drop-index': {
        state.indexes.get(step.table)?.delete(step.index)
        break
      }

      case 'drop-table': {
        state.tables.delete(step.table)
        state.shapes.delete(step.table)
        state.indexes.delete(step.table)
        break
      }

      default: {
        break
      }
    }
  }
}
