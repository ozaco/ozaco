/**
 * `@ozaco/db` — the reactive, adapter-agnostic database module. Declare tables with
 * `table`/`column`, read them through the typed `Database.Handle` that `DbClient` installs (and
 * `useDb(...tables)` resolves anywhere), refine with the portable `where` algebra, and watch any
 * query live. Driver-free: importing this never pulls in a database package — the backends live
 * at `@ozaco/db/impl/{memory,sqlite,pg,bun-sql}`.
 *
 * This barrel is the WHOLE surface an application needs. The plumbing an adapter or a Kv store
 * is built on lives in `@ozaco/db/internal`.
 */

export { CLEAR, FIELDS, VERSION_ZERO } from './const'
export { DbErrors, KvErrors } from './errors'

export { DbBus } from './definition/bus'
export { DbClient } from './definition/database'
export { Db, DbAdapter, Kv } from './definition/protocol'

export { useDb, withBusMeta } from './utils/database'
export { filterFields, filterValues, where } from './utils/filter'
export { clampLimit, sanitizeFilter } from './utils/sanitize'
export { column, defineSchema, table } from './utils/schema'

export type * from './types/adapter'
export type * from './types/bus'
export type * from './types/change'
export type * from './types/database'
export type * from './types/kv'
export type * from './types/schema'
export type * from './types/spec'
