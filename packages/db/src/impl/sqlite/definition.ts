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
import { ensure, operation } from 'std:effect'

import { Database } from 'bun:sqlite'

import {
  compileCount,
  compileDelete,
  compileFind,
  compileInsert,
  compileUpdate,
  quoteIdent,
} from '../shared/compile'
import { compileMigrateStep } from '../shared/ddl'
import { decodeRows, encodeRawParams, sqliteDialect } from '../shared/dialects'

import { createLock, exec, StateRef } from './internal'
import { runTransaction } from './transaction'

export interface SqliteAdapterOptions {
  /** Database file path, `':memory:'` (default) for an ephemeral in-process database. */
  readonly path?: string | undefined
}

/**
 * SQLite adapter over `bun:sqlite` — `install(SqliteAdapter, { path })`, then `DbClient`. The
 * handle closes with its scope. Transactions serialize on the single shared handle (nested calls
 * become savepoints); no native live feed (local writes drive reactivity).
 */
export const SqliteAdapter = DbAdapter.implement<AdapterDef.Info, [options?: SqliteAdapterOptions]>(
  {
    name: 'sqlite',
    version: '0.1.0',
    *setup(options) {
      const db = new Database(options?.path ?? ':memory:')
      yield* StateRef.set({ db, lock: createLock() })
      yield* ensure(() => {
        db.close()
      })
      return {
        adapter: 'sqlite',
        capabilities: { transactions: true, live: false, raw: true },
      }
    },
  },
).build({
  ...adapterDefaults('sqlite'),

  find: operation(function* (spec: FindSpec) {
    const statement = yield* compileFind(sqliteDialect, spec)
    const found = yield* exec(statement.text, statement.params)
    return yield* decodeRows(sqliteDialect, spec.table, found)
  }),

  count: operation(function* (spec: CountSpec) {
    const statement = yield* compileCount(sqliteDialect, spec)
    const rows = yield* exec(statement.text, statement.params)
    return Number(rows[0]?.count ?? 0)
  }),

  insert: operation(function* (table: TableSpec, rows: readonly Doc[]) {
    if (rows.length === 0) {
      return []
    }
    const statement = yield* compileInsert(sqliteDialect, table, rows)
    const found = yield* exec(statement.text, statement.params)
    return yield* decodeRows(sqliteDialect, table, found)
  }),

  update: operation(function* (spec: UpdateSpec) {
    const statement = yield* compileUpdate(sqliteDialect, spec)
    const found = yield* exec(statement.text, statement.params)
    return yield* decodeRows(sqliteDialect, spec.table, found)
  }),

  remove: operation(function* (spec: DeleteSpec) {
    const statement = yield* compileDelete(sqliteDialect, spec)
    const found = yield* exec(statement.text, statement.params)
    return yield* decodeRows(sqliteDialect, spec.table, found)
  }),

  introspect: operation(function* (table: TableSpec) {
    const rows = yield* exec(`PRAGMA table_info(${quoteIdent(table.name)})`, [])
    if (rows.length === 0) {
      return null
    }
    return { columns: rows.map(row => String(row.name)) }
  }),

  migrate: operation(function* (steps: readonly MigrateStep[]) {
    for (const step of steps) {
      for (const statement of compileMigrateStep(sqliteDialect, step)) {
        yield* exec(statement, [])
      }
    }
  }),

  transaction: runTransaction,

  raw: operation(function* (statement: string, params?: readonly unknown[], table?: TableSpec) {
    const bound = yield* encodeRawParams(sqliteDialect, params ?? [])
    const found = yield* exec(statement, bound)
    const rows = table ? yield* decodeRows(sqliteDialect, table, found) : found
    return { rows, rowCount: rows.length }
  }),
})
