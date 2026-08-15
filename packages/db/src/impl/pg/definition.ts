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
import { attempt, ensure, operation, until, useContext } from 'std:effect'
import type { AnyType } from 'std:shared'

import { Pool } from 'pg'

import {
  compileCount,
  compileDelete,
  compileFind,
  compileInsert,
  compileUpdate,
} from '../shared/compile'
import { compileMigrateStep } from '../shared/ddl'
import { decodeRows, encodeRawParam, postgresDialect } from '../shared/dialects'

import { exec, rowsOf, StateRef } from './internal'
import type { PgLiveOptions } from './live'
import { openLiveFeed, triggerSql } from './live'
import { runTransaction } from './transaction'

export interface PgAdapterOptions {
  /** `postgres://…` connection string. */
  readonly url: string
  /** Driver pool size (node-postgres `max`). Default 10. */
  readonly max?: number | undefined
  readonly ssl?: AnyType
  /** LISTEN/NOTIFY live feed (a dedicated listener connection + AFTER-row triggers on the declared
   * tables). Default true; set false to opt out (reactivity then falls back to write-through), or
   * pass a {@link PgLiveOptions} reconnect budget. */
  readonly live?: boolean | PgLiveOptions | undefined
}

/**
 * Postgres adapter over node-postgres (`pg.Pool`) — `install(PgAdapter, { url })`, then
 * `DbClient`. The driver's own pool manages connections; transactions pin one client for their
 * duration (nested calls become savepoints). Declares the `live` capability: a LISTEN/NOTIFY feed
 * (trigger-based) owns the change stream, so external writes — psql, `raw`, other processes —
 * reach watchers too.
 */
export const PgAdapter = DbAdapter.implement<AdapterDef.Info, [options: PgAdapterOptions]>({
  name: 'pg',
  version: '0.1.0',
  *setup(options) {
    const pool = new Pool({
      connectionString: options.url,
      max: options.max ?? 10,
      ssl: options.ssl,
    })
    yield* StateRef.set({
      pool,
      options: { url: options.url, ssl: options.ssl },
      liveOptions: typeof options.live === 'object' ? options.live : {},
      liveActive: false,
    })
    yield* ensure(function* () {
      yield* attempt(until(pool.end() as Promise<void>))
    })
    return {
      adapter: 'pg',
      capabilities: { transactions: true, live: options.live !== false, raw: true },
    }
  },
}).build({
  ...adapterDefaults('pg'),

  find: operation(function* (spec: FindSpec) {
    const statement = compileFind(postgresDialect, spec)
    const result = yield* exec(statement.text, statement.params)
    return decodeRows(postgresDialect, spec.table, rowsOf(result))
  }),

  count: operation(function* (spec: CountSpec) {
    const statement = compileCount(postgresDialect, spec)
    const result = yield* exec(statement.text, statement.params)
    return Number(rowsOf(result)[0]?.count ?? 0)
  }),

  insert: operation(function* (table: TableSpec, rows: readonly Doc[]) {
    if (rows.length === 0) {
      return []
    }
    const statement = compileInsert(postgresDialect, table, rows)
    const result = yield* exec(statement.text, statement.params)
    return decodeRows(postgresDialect, table, rowsOf(result))
  }),

  update: operation(function* (spec: UpdateSpec) {
    const statement = compileUpdate(postgresDialect, spec)
    const result = yield* exec(statement.text, statement.params)
    return decodeRows(postgresDialect, spec.table, rowsOf(result))
  }),

  remove: operation(function* (spec: DeleteSpec) {
    const statement = compileDelete(postgresDialect, spec)
    const result = yield* exec(statement.text, statement.params)
    return decodeRows(postgresDialect, spec.table, rowsOf(result))
  }),

  introspect: operation(function* (table: TableSpec) {
    const result = yield* exec(
      'SELECT column_name AS "name" FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema()',
      [table.name],
    )
    const rows = rowsOf(result)
    if (rows.length === 0) {
      return null
    }
    return { columns: rows.map(row => String(row.name)) }
  }),

  migrate: operation(function* (steps: readonly MigrateStep[]) {
    const state = yield* useContext(StateRef)
    for (const step of steps) {
      for (const statement of compileMigrateStep(postgresDialect, step)) {
        yield* exec(statement, [])
      }
      // tables created after the feed opened need their change trigger installed too
      if (step.kind === 'create-table' && state.liveActive) {
        yield* exec(triggerSql(step.table.name), [])
      }
    }
  }),

  live: operation(function* (tables: readonly TableSpec[]) {
    const state = yield* useContext(StateRef)
    const feed = yield* openLiveFeed(state.options, state.liveOptions, tables)
    state.liveActive = true
    return feed
  }),

  transaction: runTransaction,

  raw: operation(function* (statement: string, params?: readonly unknown[], table?: TableSpec) {
    const bound = (params ?? []).map(value => encodeRawParam(postgresDialect, value))
    const result = yield* exec(statement, bound)
    const found = rowsOf(result)
    const rows = table ? decodeRows(postgresDialect, table, found) : found
    return { rows, rowCount: Number(result?.rowCount ?? rows.length) }
  }),
})
