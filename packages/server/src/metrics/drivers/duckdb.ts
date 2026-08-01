import type { Future } from 'std:effect'
import { operation, until } from 'std:effect'
import type { AnyType } from 'std:shared'

import { DuckDBInstance } from '@duckdb/node-api'

import {
  CALL_COLUMNS,
  CALLS_TABLE,
  EVENT_COLUMNS,
  EVENTS_TABLE,
  LOG_COLUMNS,
  LOGS_TABLE,
  SCHEMA_DDL,
} from '../const'
import type { MetricsDef } from '../types'

// User-defined column types → DuckDB types. `json` is VARCHAR (JsonCodec text) — never a native JSON
// column, per the module's contract.
const COLUMN_TYPE: Record<MetricsDef.ColumnType, string> = {
  text: 'VARCHAR',
  int: 'BIGINT',
  float: 'DOUBLE',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMP',
  json: 'VARCHAR',
}

// Quote an identifier, rejecting anything that isn't a plain SQL name (defends the raw table/column
// names that flow into DDL/DML from user-defined tables).
const ident = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
    throw new Error(`invalid identifier: ${name}`)
  }
  return `"${name}"`
}

// DuckDB returns INTEGER/BIGINT/COUNT columns as JS `bigint`; normalise to `number` for JSON transport.
const toJs = (value: unknown): unknown => (typeof value === 'bigint' ? Number(value) : value)

const rowsOf = (reader: AnyType): MetricsDef.Row[] =>
  (reader.getRowObjects() as Record<string, unknown>[]).map(row => {
    const out: MetricsDef.Row = {}
    for (const key of Object.keys(row)) {
      out[key] = toJs(row[key])
    }
    return out
  })

interface InsertBatch {
  readonly table: string
  readonly columns: readonly string[]
  readonly values: ReadonlyArray<readonly unknown[]>
}

// One multi-row INSERT with a flat `$1..$n` param list (columns × rows), so a whole flush batch is a
// single statement. Column names are quoted (they're camelCase).
const insertBatch = operation(function* (connect: () => Future<AnyType>, batch: InsertBatch) {
  const { table, columns, values } = batch
  if (values.length === 0) {
    return
  }
  const width = columns.length
  const tuples = values.map(
    (_, row) => `(${columns.map((_column, col) => `$${row * width + col + 1}`).join(', ')})`,
  )
  const cols = columns.map(name => `"${name}"`).join(', ')
  const db = yield* connect()
  yield* until(db.run(`INSERT INTO ${table} (${cols}) VALUES ${tuples.join(', ')}`, values.flat()))
})

const COPY_FORMAT: Record<NonNullable<MetricsDef.TransferSpec['format']>, string> = {
  parquet: 'FORMAT PARQUET',
  csv: 'FORMAT CSV, HEADER',
  json: 'FORMAT JSON',
}

/**
 * The DuckDB metrics store — a self-contained, isolated analytics database (embedded, PostgreSQL-shaped
 * SQL) living inside `@ozaco/server/metrics`, and EFFECT-NATIVE (every method is an `operation` that
 * wraps DuckDB's async API with `until`). `':memory:'` by default, or a file path to persist. Custom
 * fields ride in a `meta` VARCHAR column (JsonCodec text — never a native JSON column). DuckDB's own
 * `COPY` powers bulk {@link MetricsDef.Store.export}/`import` to Parquet/CSV/JSON.
 */
export const createDuckdbStore = (path: string): MetricsDef.Store => {
  let instance: AnyType = null
  let connection: AnyType = null

  const connect = operation(function* () {
    if (!instance) {
      instance = yield* until(DuckDBInstance.create(path) as Promise<AnyType>)
    }
    if (!connection) {
      connection = yield* until((instance as AnyType).connect() as Promise<AnyType>)
    }
    return connection as AnyType
  })

  return {
    dialect: 'duckdb',
    init: operation(function* () {
      const db = yield* connect()
      for (const ddl of SCHEMA_DDL) {
        yield* until(db.run(ddl))
      }
    }),
    insertCalls: operation(function* (rows: readonly MetricsDef.StoredCall[]) {
      yield* insertBatch(connect, {
        table: CALLS_TABLE,
        columns: CALL_COLUMNS,
        values: rows.map(r => [
          r.ts,
          r.service,
          r.action,
          r.status,
          r.durationMs,
          r.requestId,
          r.error,
          r.meta,
        ]),
      })
    }),
    insertLogs: operation(function* (rows: readonly MetricsDef.StoredLog[]) {
      yield* insertBatch(connect, {
        table: LOGS_TABLE,
        columns: LOG_COLUMNS,
        values: rows.map(r => [r.ts, r.level, r.msg, r.error, r.meta]),
      })
    }),
    insertEvents: operation(function* (rows: readonly MetricsDef.StoredEvent[]) {
      yield* insertBatch(connect, {
        table: EVENTS_TABLE,
        columns: EVENT_COLUMNS,
        values: rows.map(r => [r.ts, r.name, r.value, r.meta]),
      })
    }),
    query: operation(function* (sql: string, params: readonly unknown[] = []) {
      const db = yield* connect()
      return rowsOf(yield* until(db.runAndReadAll(sql, [...params])))
    }),
    define: operation(function* ({ table, columns }: MetricsDef.DefineSpec) {
      const cols = Object.entries(columns)
        .map(([name, type]) => `${ident(name)} ${COLUMN_TYPE[type]}`)
        .join(', ')
      const db = yield* connect()
      yield* until(db.run(`CREATE TABLE IF NOT EXISTS ${ident(table)} (${cols})`))
    }),
    insertRow: operation(function* ({ table, columns, values }: MetricsDef.RowInsert) {
      const cols = columns.map(ident).join(', ')
      const placeholders = columns.map((_column, index) => `$${index + 1}`).join(', ')
      const db = yield* connect()
      yield* until(
        db.run(`INSERT INTO ${ident(table)} (${cols}) VALUES (${placeholders})`, [...values]),
      )
    }),
    export: operation(function* ({
      table,
      path: file,
      format = 'parquet',
    }: MetricsDef.TransferSpec) {
      const db = yield* connect()
      yield* until(
        db.run(`COPY ${ident(table)} TO '${file.replaceAll("'", "''")}' (${COPY_FORMAT[format]})`),
      )
    }),
    import: operation(function* ({
      table,
      path: file,
      format = 'parquet',
    }: MetricsDef.TransferSpec) {
      const db = yield* connect()
      yield* until(
        db.run(
          `COPY ${ident(table)} FROM '${file.replaceAll("'", "''")}' (${COPY_FORMAT[format]})`,
        ),
      )
    }),
    prune: operation(function* ({ table, before }: MetricsDef.PruneSpec) {
      // DuckDB's DELETE returns a single `{ Count }` row — the deleted count, without materializing the
      // removed rows.
      const db = yield* connect()
      const reader: AnyType = yield* until(
        db.runAndReadAll(`DELETE FROM ${ident(table)} WHERE "ts" < $1`, [before]),
      )
      const rows = reader.getRowObjects() as Record<string, unknown>[]
      return Number(rows[0]?.Count ?? 0)
    }),
    close: operation(function* () {
      connection?.disconnectSync()
      instance?.closeSync()
      connection = null
      instance = null
    }),
  }
}
