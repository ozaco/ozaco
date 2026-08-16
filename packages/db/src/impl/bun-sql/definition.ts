import type {
  AdapterDef,
  CountSpec,
  DeleteSpec,
  Doc,
  FindSpec,
  MigrateStep,
  TableSpec,
  UpdateSpec,
} from 'db:core'
import { adapterDefaults, DbAdapter } from 'db:core'
import { attempt, ensure, operation, until } from 'std:effect'
import type { AnyType } from 'std:shared'

import { SQL } from 'bun'

import {
  compileCount,
  compileDelete,
  compileFind,
  compileInsert,
  compileUpdate,
} from '../shared/compile'
import { compileMigrateStep } from '../shared/ddl'
import { decodeRows, encodeRawParams, postgresDialect } from '../shared/dialects'

import { exec, StateRef } from './internal'
import { runTransaction } from './transaction'

const SqlClient = SQL as AnyType

export interface BunSqlAdapterOptions {
  /** `postgres://…` connection string. */
  readonly url: string
  /** Driver pool size (Bun SQL `max`). Default 10. */
  readonly max?: number | undefined
}

/**
 * Postgres adapter over Bun's built-in `SQL` client — `install(BunSqlAdapter, { url })`, then
 * `DbClient`. Bun manages the connection pool; transactions reserve one connection for their
 * duration (nested calls become savepoints). No native live feed yet.
 */
export const BunSqlAdapter = DbAdapter.implement<AdapterDef.Info, [options: BunSqlAdapterOptions]>({
  name: 'bun-sql',
  version: '0.1.0',
  *setup(options) {
    const client = new SqlClient(options.url, { max: options.max ?? 10 })
    yield* StateRef.set({ client })
    yield* ensure(function* () {
      yield* attempt(until((client.close?.() ?? client.end?.()) as Promise<void>))
    })
    return {
      adapter: 'bun-sql',
      capabilities: { transactions: true, live: false, raw: true },
    }
  },
}).build({
  ...adapterDefaults('bun-sql'),

  find: operation(function* (spec: FindSpec) {
    const statement = yield* compileFind(postgresDialect, spec)
    const found = yield* exec(statement.text, statement.params)
    return yield* decodeRows(postgresDialect, spec.table, found)
  }),

  count: operation(function* (spec: CountSpec) {
    const statement = yield* compileCount(postgresDialect, spec)
    const rows = yield* exec(statement.text, statement.params)
    return Number(rows[0]?.count ?? 0)
  }),

  insert: operation(function* (table: TableSpec, rows: readonly Doc[]) {
    if (rows.length === 0) {
      return []
    }
    const statement = yield* compileInsert(postgresDialect, table, rows)
    const found = yield* exec(statement.text, statement.params)
    return yield* decodeRows(postgresDialect, table, found)
  }),

  update: operation(function* (spec: UpdateSpec) {
    const statement = yield* compileUpdate(postgresDialect, spec)
    const found = yield* exec(statement.text, statement.params)
    return yield* decodeRows(postgresDialect, spec.table, found)
  }),

  remove: operation(function* (spec: DeleteSpec) {
    const statement = yield* compileDelete(postgresDialect, spec)
    const found = yield* exec(statement.text, statement.params)
    return yield* decodeRows(postgresDialect, spec.table, found)
  }),

  introspect: operation(function* (table: TableSpec) {
    const rows = yield* exec(
      'SELECT column_name AS "name" FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema()',
      [table.name],
    )
    if (rows.length === 0) {
      return null
    }
    return { columns: rows.map(row => String(row.name)) }
  }),

  migrate: operation(function* (steps: readonly MigrateStep[]) {
    for (const step of steps) {
      for (const statement of compileMigrateStep(postgresDialect, step)) {
        yield* exec(statement, [])
      }
    }
  }),

  transaction: runTransaction,

  raw: operation(function* (statement: string, params?: readonly unknown[], table?: TableSpec) {
    const bound = yield* encodeRawParams(postgresDialect, params ?? [])
    const found = yield* exec(statement, bound)
    const rows = table ? yield* decodeRows(postgresDialect, table, found) : found
    return { rows, rowCount: rows.length }
  }),
})
