import type { IndexSpec, MigrateStep } from 'db:core'
import { CREATED, UPDATED, VERSION } from 'db:core'

import type { MemoryState } from './state'

/** Apply reconcile steps to the in-memory shapes/tables/indexes. */
export const applySteps = (state: MemoryState, steps: readonly MigrateStep[]): void => {
  for (const step of steps) {
    switch (step.kind) {
      case 'create-table': {
        if (!state.shapes.has(step.table.name)) {
          state.shapes.set(step.table.name, new Set(step.table.columns.map(column => column.name)))
        }
        if (!state.tables.has(step.table.name)) {
          state.tables.set(step.table.name, new Map())
        }
        break
      }
      case 'add-column': {
        state.shapes.get(step.table)?.add(step.column.name)
        const backfill =
          step.column.name === VERSION
            ? 1
            : step.column.name === CREATED || step.column.name === UPDATED
              ? 0
              : null
        for (const doc of state.tables.get(step.table)?.values() ?? []) {
          doc[step.column.name] = backfill
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
        const forTable = state.indexes.get(step.table) ?? new Map<string, IndexSpec>()
        forTable.set(step.index.name, step.index)
        state.indexes.set(step.table, forTable)
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
