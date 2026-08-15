import type { MigrateStep } from './types/adapter'

/** Whether a reconcile step destroys data (skipped by `safe: true`). */
export const isDestructive = (step: MigrateStep): boolean =>
  step.kind === 'drop-column' || step.kind === 'drop-table'
