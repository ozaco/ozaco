import type { TableDef } from './types'

/** The full stored row type for a table (validated fields + system fields) — read back from the
 * table's resolved type param, so no zod inference happens at every use site. */
export type Infer<TTable extends TableDef> =
  TTable extends TableDef<string, infer TDoc, unknown> ? TDoc : never

/** The accepted insert shape (pre-defaults, no system fields). */
export type InferInsert<TTable extends TableDef> =
  TTable extends TableDef<string, unknown, infer TInsert> ? TInsert : never
