import { TABLE } from '../const'
import { SYSTEM_FIELDS } from '../internal/const'
import type { Schema } from '../types/schema'
import type { Spec } from '../types/spec'

/** Whether a runtime value is a `column.*` declaration. */
/** Whether a runtime value is a `table()` declaration. */
export const isTable = (value: unknown): value is Schema.Table =>
  typeof value === 'object' && value !== null && (value as Schema.Table)._t === TABLE

/** Whether a column name is one of the implicit system fields (`_id`, `_created_at`, …). */
export const isSystemField = (name: string): boolean => SYSTEM_FIELDS.has(name)

/** Whether a reconcile step destroys data (skipped by `safe: true`). */
export const isDestructive = (
  step: Spec.Step,
): step is Spec.Step & { kind: Spec.DestructiveKind } =>
  step.kind === 'drop-column' || step.kind === 'drop-table' || step.kind === 'alter-column'
