import type { ColumnKind, Doc, TableSpec } from 'db:core'
import { DbErrors } from 'db:core'
import { CodecErrors } from 'std:codec'
import { attempt, operation } from 'std:effect'
import { isFailure } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { quoteIdent } from './compile'
import type { SqlDialect } from './types'

const encodeShared = operation(function* (kind: ColumnKind, value: unknown) {
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
})

/** A `json` column read back: text decodes through the codec, anything unreadable passes through
 * verbatim (a column written by hand or by a foreign writer is data, not a failure). */
const decodeJson = operation(function* (value: unknown) {
  if (typeof value !== 'string') {
    return value
  }
  const parsed = yield* attempt(() => JsonCodec.actions.parse<unknown>(value))
  if (isFailure(parsed)) {
    // only unreadable JSON falls back — a missing JsonCodec install must surface as itself
    return parsed.error === CodecErrors.Parse ? value : yield* parsed
  }
  return parsed.value
})

const decodeShared = operation(function* (kind: ColumnKind, value: unknown) {
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
})

/** Postgres-family dialect (node-postgres and Bun SQL). */
export const postgresDialect: SqlDialect = {
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
  encode: encodeShared,
  decode: decodeShared,
}

/** SQLite dialect (bun:sqlite). Booleans are stored as 0/1. */
export const sqliteDialect: SqlDialect = {
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
  encode: operation(function* (kind, value) {
    if (kind === 'boolean' && typeof value === 'boolean') {
      return value ? 1 : 0
    }
    return yield* encodeShared(kind, value)
  }),
  decode: decodeShared,
}

/** Decode one raw driver row back to app-level values by declared column kind. Undeclared columns
 * pass through untouched. */
export const decodeRow = operation(function* (dialect: SqlDialect, table: TableSpec, row: Doc) {
  const out: Record<string, unknown> = { ...row }
  for (const column of table.columns) {
    if (column.name in out) {
      out[column.name] = yield* dialect.decode(column.kind, out[column.name])
    }
  }
  return out as Doc
})

export const decodeRows = operation(function* (
  dialect: SqlDialect,
  table: TableSpec,
  rows: readonly Doc[],
) {
  const out: Doc[] = []
  for (const row of rows) {
    out.push(yield* decodeRow(dialect, table, row))
  }
  return out as readonly Doc[]
})

/** Normalize one user-supplied `raw` bind param from app values to storage values: `Date` →
 * timestamp encoding, booleans/plain objects/arrays per dialect (`json` as text). Primitives and
 * binary pass through untouched. */
export const encodeRawParam = operation(function* (dialect: SqlDialect, value: unknown) {
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
})

/** Normalize every user-supplied `raw` bind param (see {@link encodeRawParam}). */
export const encodeRawParams = operation(function* (
  dialect: SqlDialect,
  params: readonly unknown[],
) {
  const bound: unknown[] = []
  for (const value of params) {
    bound.push(yield* encodeRawParam(dialect, value))
  }
  return bound
})

/** Map a Postgres SQLSTATE to the matching `DbErrors` tag (shared by pg and bun-sql). */
export const classifySqlState = (code: unknown, message: string): string => {
  const state = typeof code === 'string' ? code : ''
  if (state === '23505') {
    return DbErrors.Unique
  }
  if (state === '23503') {
    return DbErrors.ForeignKey
  }
  if (state === '23502') {
    return DbErrors.NotNull
  }
  if (state === '23514') {
    return DbErrors.Check
  }
  if (state === '40001' || state === '40P01') {
    return DbErrors.Conflict
  }
  if (state.startsWith('08') || state === '57P01' || state === '57P02' || state === '57P03') {
    return DbErrors.Connection
  }
  // fallback shape checks for drivers that hide the SQLSTATE
  if (/unique|duplicate key/iu.test(message)) {
    return DbErrors.Unique
  }
  return DbErrors.Query
}
