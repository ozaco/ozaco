import { operation } from 'std:effect'

import { DbAdapter } from '../adapter'
import { SYSTEM_NAMES } from '../const'
import type { MigrateStep, MigrationPlan } from '../types/adapter'
import type { TableSpec } from '../types/schema'
import { isDestructive } from '../utils'

/**
 * Compute (without executing) the reconcile from the live storage to the declared schema: create
 * missing tables, add missing columns (system columns included), drop undeclared ones, and (re)
 * declare indexes (adapters treat create steps as idempotent).
 */
export const planMigration = operation(function* (specs: readonly TableSpec[]) {
  const steps: MigrateStep[] = []
  for (const spec of specs) {
    const shape = yield* DbAdapter.actions.introspect(spec)
    if (!shape) {
      steps.push({ kind: 'create-table', table: spec })
      for (const index of spec.indexes) {
        steps.push({ kind: 'create-index', table: spec.name, index })
      }
      continue
    }
    const existing = new Set(shape.columns)
    for (const column of spec.columns) {
      if (!existing.has(column.name)) {
        steps.push({ kind: 'add-column', table: spec.name, column })
      }
    }
    const declared = new Set(spec.columns.map(column => column.name))
    for (const name of shape.columns) {
      if (!declared.has(name) && !SYSTEM_NAMES.includes(name)) {
        steps.push({ kind: 'drop-column', table: spec.name, column: name })
      }
    }
    for (const index of spec.indexes) {
      steps.push({ kind: 'create-index', table: spec.name, index })
    }
  }
  return { steps } as MigrationPlan
})

/** Execute a plan. In safe mode destructive steps (drop-column/drop-table) are skipped. */
export const applyPlan = operation(function* (plan: MigrationPlan, options: { safe: boolean }) {
  const steps = plan.steps.filter(step => !(options.safe && isDestructive(step)))
  if (steps.length > 0) {
    yield* DbAdapter.actions.migrate(steps)
  }
})
