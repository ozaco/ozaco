// oxlint-disable import/exports-last
import type { DatabasePool, QuerySqlToken } from 'db:core'
import { QUERY_TOKEN, sql } from 'db:core'
import { attempt, operation } from 'std:effect'
import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Column, ColumnKind, Index, SchemaDef, TableDef } from '../schema/types'
import type { ApplyOptions, MigrationPlan, MigrationStatement } from '../types/migrate'

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

const existingColumns = operation(function* (pool: DatabasePool, table: string) {
  // Postgres path. On backends without information_schema (e.g. SQLite) this fails; treat the table
  // as new (an in-memory/fresh DB → CREATE TABLE covers it).
  const outcome = yield* attempt(
    pool.any(
      sql`SELECT column_name AS "name" FROM information_schema.columns WHERE table_name = ${table} AND table_schema = current_schema()` as QuerySqlToken<AnyType>,
    ),
  )
  if (isFailure(outcome)) {
    return new Set<string>()
  }
  return new Set(outcome.value.map((row: AnyType) => String(row.name)))
})

/** Compute (without executing) the reconcile from the live schema to the code schema. Ensures the
 * system columns exist on pre-existing tables too, adds missing user columns, drops undeclared ones,
 * and creates declared indexes. */
export const planSchema = operation(function* (pool: DatabasePool, schema: SchemaDef) {
  const statements: MigrationStatement[] = []
  for (const def of Object.values(schema.tables) as TableDef[]) {
    statements.push({
      kind: 'create-table',
      table: def.name,
      sql: createTableSql(def),
      destructive: false,
    })
    const existing = yield* existingColumns(pool, def.name)
    if (existing.size > 0) {
      // ensure system columns exist on an already-created table
      for (const column of SYSTEM_COLUMNS) {
        if (column.name !== '_id' && !existing.has(column.name)) {
          statements.push({
            kind: 'add-column',
            table: def.name,
            sql: `ALTER TABLE ${quote(def.name)} ADD COLUMN ${column.ddl.replace(`${quote(column.name)} `, `${quote(column.name)} `)}`,
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
  const plan = yield* planSchema(pool, schema)
  yield* applyPlan(pool, plan, options)
})
