// oxlint-disable import/exports-last
import type { Spec } from 'db:core'
import { DbErrors } from 'db:core'
import { CodecErrors } from 'std:codec'
import { attempt } from 'std:effect'
import { isFailure } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { quoteIdent } from './compile'
import type { Sql } from './types'

function* encodeShared(kind: Spec.ColumnKind, value: unknown) {
  if (value === null || value === undefined) {
    return null
  }

  if (kind === 'timestamp') {
    return value instanceof Date ? value.getTime() : value
  }

  if (kind === 'json') {
    return yield* JsonCodec.actions.stringify(value)
  }

  return value
}

/** A `json` column read back: text decodes through the codec, anything unreadable passes through
 * verbatim (a column written by hand or by a foreign writer is data, not a failure). */
function* decodeJson(value: unknown) {
  if (typeof value !== 'string') {
    return value
  }

  const parsed = yield* attempt(() => JsonCodec.actions.parse<unknown>(value))

  if (isFailure(parsed)) {
    // only unreadable JSON falls back — a missing JsonCodec install must surface as itself
    return parsed.error === CodecErrors.Parse ? value : yield* parsed
  }

  return parsed.value
}

function* decodeShared(kind: Spec.ColumnKind, value: unknown) {
  if (value === null || value === undefined) {
    return null
  }

  switch (kind) {
    case 'timestamp': {
      return value instanceof Date ? value : new Date(Number(value))
    }

    case 'json': {
      return yield* decodeJson(value)
    }
    case 'int':
    case 'float': {
      return Number(value)
    }

    case 'boolean': {
      return typeof value === 'number' ? value !== 0 : Boolean(value)
    }

    default: {
      return value
    }
  }
}

/** Postgres-family dialect (node-postgres and Bun SQL). */
export const postgresDialect: Sql.Dialect = {
  placeholder: index => `$${index}`,

  types: {
    text: 'TEXT',
    enum: 'TEXT',
    int: 'BIGINT',
    float: 'DOUBLE PRECISION',
    boolean: 'BOOLEAN',
    timestamp: 'BIGINT',
    json: 'TEXT',
  },
  ilike: 'ILIKE',
  reindexTable: table => `REINDEX TABLE ${quoteIdent(table)}`,
  alterColumn: (table, column, type) =>
    `ALTER TABLE ${quoteIdent(table)} ALTER COLUMN ${quoteIdent(column)} TYPE ${type} USING ${quoteIdent(column)}::${type}`,

  tables: () => ({
    text: 'SELECT table_name AS "name" FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = \'BASE TABLE\'',
    params: [],
  }),

  introspect: table => ({
    text: 'SELECT column_name AS "name", data_type AS "type" FROM information_schema.columns WHERE table_name = $1 AND table_schema = current_schema()',
    params: [table],
  }),
  encode: encodeShared,
  decode: decodeShared,
}

/** SQLite dialect (bun:sqlite). Booleans are stored as 0/1. */
export const sqliteDialect: Sql.Dialect = {
  placeholder: () => '?',

  types: {
    text: 'TEXT',
    enum: 'TEXT',
    int: 'INTEGER',
    float: 'REAL',
    boolean: 'INTEGER',
    timestamp: 'INTEGER',
    json: 'TEXT',
  },
  ilike: null,
  reindexTable: table => `REINDEX ${quoteIdent(table)}`,

  // sqlite cannot retype in place (it takes a table rebuild) — the planner reports the drift
  alterColumn: null,

  tables: () => ({
    text: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    params: [],
  }),
  introspect: table => ({ text: `PRAGMA table_info(${quoteIdent(table)})`, params: [] }),
  *encode(kind, value) {
    if (kind === 'boolean' && typeof value === 'boolean') {
      return value ? 1 : 0
    }

    return yield* encodeShared(kind, value)
  },
  decode: decodeShared,
}

/** Decode one raw driver row back to app-level values by declared column kind. Undeclared
 * columns pass through untouched. */
function* decodeRow(dialect: Sql.Dialect, table: Spec.Table, row: Spec.Doc) {
  const out: Record<string, unknown> = { ...row }

  for (const column of table.columns) {
    if (column.name in out) {
      out[column.name] = yield* dialect.decode(column.kind, out[column.name])
    }
  }

  return out as Spec.Doc
}

export function* decodeRows(dialect: Sql.Dialect, table: Spec.Table, rows: readonly Spec.Doc[]) {
  const out: Spec.Doc[] = []

  for (const row of rows) {
    out.push(yield* decodeRow(dialect, table, row))
  }

  return out as readonly Spec.Doc[]
}

/** Normalize one user-supplied `raw` bind param from app values to storage values: `Date` →
 * timestamp encoding, booleans/plain objects/arrays per dialect (`json` as text). Primitives and
 * binary pass through untouched. */
function* encodeRawParam(dialect: Sql.Dialect, value: unknown) {
  if (value === null || value === undefined) {
    return null
  }

  if (value instanceof Date) {
    return yield* dialect.encode('timestamp', value)
  }

  if (typeof value === 'boolean') {
    return yield* dialect.encode('boolean', value)
  }

  if (typeof value === 'object' && !(value instanceof Uint8Array)) {
    return yield* dialect.encode('json', value)
  }

  return value
}

/** Normalize every user-supplied `raw` bind param (see {@link encodeRawParam}). */
export function* encodeRawParams(dialect: Sql.Dialect, params: readonly unknown[]) {
  const bound: unknown[] = []

  for (const value of params) {
    bound.push(yield* encodeRawParam(dialect, value))
  }

  return bound
}

/** Map a Postgres SQLSTATE to the matching `DbErrors` tag (shared by pg and bun-sql). */
export const classifySqlState = (code: unknown, message: string): string => {
  const state = typeof code === 'string' ? code : ''

  switch (state) {
    case '23505': {
      return DbErrors.Unique
    }

    case '23503': {
      return DbErrors.ForeignKey
    }

    case '23502': {
      return DbErrors.NotNull
    }

    case '23514': {
      return DbErrors.Check
    }
    case '40001':
    case '40P01': {
      return DbErrors.Conflict
    }
    case '57P01':
    case '57P02':
    case '57P03': {
      return DbErrors.Connection
    }

    default: {
      break
    }
  }

  if (state.startsWith('08')) {
    return DbErrors.Connection
  }

  // fallback shape checks for drivers that hide the SQLSTATE
  if (/unique|duplicate key/iu.test(message)) {
    return DbErrors.Unique
  }

  return DbErrors.Query
}
