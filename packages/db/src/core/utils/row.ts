import { FIELDS } from '../const'
import type { Schema } from '../types/schema'

/**
 * A copy of a row WITHOUT its system fields (`_id`, `_created_at`, `_updated_at`, `_version`) —
 * what to hand `insert` when a row should become a NEW document elsewhere (a clone, a fixture).
 * To move a row and keep its identity, use `db.import(table, rows)` instead.
 */
export const stripSystem = <TRow extends object>(
  row: TRow,
): Omit<TRow, keyof Schema.SystemFields> => {
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) }

  for (const field of [FIELDS.id, FIELDS.created, FIELDS.updated, FIELDS.version]) {
    Reflect.deleteProperty(out, field)
  }

  return out as Omit<TRow, keyof Schema.SystemFields>
}
