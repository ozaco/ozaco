// oxlint-disable import/exports-last
import type { DatabasePool, QuerySqlToken } from 'db:core'
import { QUERY_TOKEN, sql } from 'db:core'
import { attempt, operation } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Column, ColumnKind, Index, SchemaDef, TableDef } from '../schema/types'
import type { ApplyOptions, Dialect, MigrationPlan, MigrationStatement } from '../types/migrate'

const PG_TYPES: Record<ColumnKind, string> = {
  text: 'TEXT',
  enum: 'TEXT',
  int: 'INTEGER',
  float: 'DOUBLE PRECISION',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMPTZ',
  json: 'JSONB',
}

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`
const rawToken = (text: string): QuerySqlToken =>
  ({ type: QUERY_TOKEN, sql: text, values: [], parser: null }) as QuerySqlToken

const SYSTEM_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: '_id', ddl: `${quote('_id')} TEXT PRIMARY KEY` },
  { name: '_createdAt', ddl: `${quote('_createdAt')} BIGINT NOT NULL` },
  { name: '_version', ddl: `${quote('_version')} INTEGER NOT NULL DEFAULT 1` },
]
const SYSTEM_NAMES = new Set(SYSTEM_COLUMNS.map(column => column.name))

const columnDdl = (column: Column): string =>
  `${quote(column.name)} ${PG_TYPES[column.kind]}${column.optional ? '' : ' NOT NULL'}`

const createTableSql = (def: TableDef): string =>
  `CREATE TABLE IF NOT EXISTS ${quote(def.name)} (${[
    ...SYSTEM_COLUMNS.map(column => column.ddl),
    ...def.columns.map(columnDdl),
  ].join(', ')})`

// index names are prefixed with the table so they don't collide across tables (Postgres index names
// are schema-global).
const createIndexSql = (def: TableDef, index: Index): string =>
  `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${quote(`${def.name}__${index.name}`)} ON ${quote(def.name)} (${index.columns.map(quote).join(', ')})`

// --- SurrealQL DDL ---------------------------------------------------------------------------------
// SurrealDB has no `CREATE TABLE` / `ALTER TABLE`: a table is a `DEFINE TABLE` and, left SCHEMALESS,
// it grows its fields implicitly on first write — so there is no column reconcile to plan, and the
// system columns (`_id`/`_createdAt`/`_version`) are just stamped by the write path. Identifiers stay
// double-quoted here; the surreal driver rewrites `"x"` → `` `x` `` on the way out (see toSurreal).
const defineTableSql = (def: TableDef): string =>
  `DEFINE TABLE IF NOT EXISTS ${quote(def.name)} SCHEMALESS`

const defineIndexSql = (def: TableDef, index: Index): string =>
  `DEFINE INDEX IF NOT EXISTS ${quote(`${def.name}__${index.name}`)} ON TABLE ${quote(def.name)} FIELDS ${index.columns.map(quote).join(', ')}${index.unique ? ' UNIQUE' : ''}`

/** Plan the SurrealQL reconcile: one `DEFINE TABLE … SCHEMALESS` per table plus its declared indexes.
 * Pure (no introspection) — SurrealDB is schemaless, so a fresh `DEFINE … IF NOT EXISTS` is idempotent
 * and there are no columns to add/drop. */
const planSchemaSurreal = (schema: SchemaDef): MigrationPlan => {
  const statements: MigrationStatement[] = []
  for (const def of Object.values(schema.tables) as TableDef[]) {
    statements.push({
      kind: 'create-table',
      table: def.name,
      sql: defineTableSql(def),
      destructive: false,
    })
    for (const index of def.indexes) {
      statements.push({
        kind: 'create-index',
        table: def.name,
        sql: defineIndexSql(def, index),
        destructive: false,
      })
    }
  }
  return { statements }
}

const existingColumns = operation(function* (pool: DatabasePool, table: string, dialect: Dialect) {
  // SQLite has no information_schema — its column list comes from `PRAGMA table_info(...)` (both
  // shapes expose a `name` column). Any failure (e.g. the table doesn't exist yet) → treat as new, so
  // CREATE TABLE covers it. SurrealDB never reaches here (its planner short-circuits, being schemaless).
  const query =
    dialect === 'sqlite'
      ? (rawToken(`PRAGMA table_info(${quote(table)})`) as QuerySqlToken<AnyType>)
      : (sql`SELECT column_name AS "name" FROM information_schema.columns WHERE table_name = ${table} AND table_schema = current_schema()` as QuerySqlToken<AnyType>)
  const outcome = yield* attempt(pool.any(query))
  if (isFailure(outcome)) {
    return new Set<string>()
  }
  return new Set(outcome.value.map((row: AnyType) => String(row.name)))
})

/** Compute (without executing) the reconcile from the live schema to the code schema. Ensures the
 * system columns exist on pre-existing tables too, adds missing user columns, drops undeclared ones,
 * and creates declared indexes. */
export const planSchema = operation(function* (
  pool: DatabasePool,
  schema: SchemaDef,
  dialect: Dialect = 'postgres',
) {
  if (dialect === 'surreal') {
    return planSchemaSurreal(schema)
  }
  const statements: MigrationStatement[] = []
  for (const def of Object.values(schema.tables) as TableDef[]) {
    statements.push({
      kind: 'create-table',
      table: def.name,
      sql: createTableSql(def),
      destructive: false,
    })
    const existing = yield* existingColumns(pool, def.name, dialect)
    if (existing.size > 0) {
      // ensure system columns exist on an already-created table
      for (const column of SYSTEM_COLUMNS) {
        if (column.name !== '_id' && !existing.has(column.name)) {
          statements.push({
            kind: 'add-column',
            table: def.name,
            sql: `ALTER TABLE ${quote(def.name)} ADD COLUMN ${column.ddl}`,
            destructive: false,
          })
        }
      }
      for (const column of def.columns) {
        if (!existing.has(column.name)) {
          statements.push({
            kind: 'add-column',
            table: def.name,
            sql: `ALTER TABLE ${quote(def.name)} ADD COLUMN ${columnDdl(column)}`,
            destructive: false,
          })
        }
      }
      const declared = new Set(def.columns.map(column => column.name))
      for (const name of existing) {
        if (!SYSTEM_NAMES.has(name) && !declared.has(name)) {
          statements.push({
            kind: 'drop-column',
            table: def.name,
            sql: `ALTER TABLE ${quote(def.name)} DROP COLUMN ${quote(name)}`,
            destructive: true,
          })
        }
      }
    }
    for (const index of def.indexes) {
      statements.push({
        kind: 'create-index',
        table: def.name,
        sql: createIndexSql(def, index),
        destructive: false,
      })
    }
  }
  return { statements } as MigrationPlan
})

/** Execute a plan. In safe mode (`allowDestructive: false`) DROP COLUMN steps are skipped. */
export const applyPlan = operation(function* (
  pool: DatabasePool,
  plan: MigrationPlan,
  options: ApplyOptions = {},
) {
  const allowDestructive = options.allowDestructive ?? true
  for (const statement of plan.statements) {
    if (statement.destructive && !allowDestructive) {
      continue
    }
    yield* pool.query(rawToken(statement.sql))
  }
})

/** Plan then apply in one step (the automatic-migration entry point). */
export const applySchema = operation(function* (
  pool: DatabasePool,
  schema: SchemaDef,
  options: ApplyOptions = {},
) {
  const plan = yield* planSchema(pool, schema, options.dialect)
  yield* applyPlan(pool, plan, options)
})

// --- imperative DDL (portable across postgres / sqlite / surreal) ----------------------------------
// One-off DDL the declarative reconcile does not do (it only ever CREATEs). Identifiers are emitted
// double-quoted; the surreal driver rewrites them to backticks. Dropping is IMPERATIVE by design —
// auto-dropping whatever the schema no longer declares would be unsafe on a shared database.

/** What the DDL operations need from the installed realtime DB. {@link RealtimeState} satisfies it. */
export interface DdlContext {
  readonly pool: DatabasePool
  readonly dialect: Dialect
  readonly schema: SchemaDef
}

/** Drop a table if it exists (Postgres/SQLite `DROP TABLE`, SurrealDB `REMOVE TABLE`). */
export const dropTable = operation(function* (ctx: DdlContext, table: string) {
  const text =
    ctx.dialect === 'surreal'
      ? `REMOVE TABLE IF EXISTS ${quote(table)}`
      : `DROP TABLE IF EXISTS ${quote(table)}`
  yield* ctx.pool.query(rawToken(text))
})

/** Drop a declared index (name auto-prefixed with the table, matching how it was created) if it
 * exists (Postgres/SQLite `DROP INDEX`, SurrealDB `REMOVE INDEX … ON TABLE`). */
export const dropIndex = operation(function* (ctx: DdlContext, table: string, indexName: string) {
  const full = quote(`${table}__${indexName}`)
  const text =
    ctx.dialect === 'surreal'
      ? `REMOVE INDEX IF EXISTS ${full} ON TABLE ${quote(table)}`
      : `DROP INDEX IF EXISTS ${full}`
  yield* ctx.pool.query(rawToken(text))
})

/** Rebuild a table's indexes. Postgres/SQLite reindex the whole table in one statement; SurrealDB has
 * no table-wide reindex, so each declared index is rebuilt via `REBUILD INDEX … ON TABLE`. */
export const reindex = operation(function* (ctx: DdlContext, table: string) {
  if (ctx.dialect === 'surreal') {
    const def = ctx.schema.tables[table] as TableDef | undefined
    for (const index of def?.indexes ?? []) {
      yield* ctx.pool.query(
        rawToken(
          `REBUILD INDEX IF EXISTS ${quote(`${table}__${index.name}`)} ON TABLE ${quote(table)}`,
        ),
      )
    }
    return
  }
  const text =
    ctx.dialect === 'sqlite' ? `REINDEX ${quote(table)}` : `REINDEX TABLE ${quote(table)}`
  yield* ctx.pool.query(rawToken(text))
})
