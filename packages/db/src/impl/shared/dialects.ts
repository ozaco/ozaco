// oxlint-disable import/exports-last
import type { ColumnKind, Doc, TableSpec } from 'db:core'
import { DbErrors } from 'db:core'

import { quoteIdent } from './compile'
import type { SqlDialect } from './types'

const encodeShared = (kind: ColumnKind, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null
  }
  if (kind === 'timestamp') {
    return value instanceof Date ? value.getTime() : value
  }
  if (kind === 'json') {
    return JSON.stringify(value)
  }
  return value
}

const decodeJson = (value: unknown): unknown => {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

const decodeShared = (kind: ColumnKind, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null
  }
  switch (kind) {
    case 'timestamp': {
      return value instanceof Date ? value : new Date(Number(value))
    }
    case 'json': {
      return decodeJson(value)
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
  encode: (kind, value) => {
    if (kind === 'boolean' && typeof value === 'boolean') {
      return value ? 1 : 0
    }
    return encodeShared(kind, value)
  },
  decode: decodeShared,
}

/** Decode one raw driver row back to app-level values by declared column kind. Undeclared columns
 * pass through untouched. */
export const decodeRow = (dialect: SqlDialect, table: TableSpec, row: Doc): Doc => {
  const out: Record<string, unknown> = { ...row }
  for (const column of table.columns) {
    if (column.name in out) {
      out[column.name] = dialect.decode(column.kind, out[column.name])
    }
  }
  return out
}

export const decodeRows = (
  dialect: SqlDialect,
  table: TableSpec,
  rows: readonly Doc[],
): readonly Doc[] => rows.map(row => decodeRow(dialect, table, row))

/** Normalize one user-supplied `raw` bind param from app values to storage values: `Date` →
 * timestamp encoding, booleans/plain objects/arrays per dialect (`json` as text). Primitives and
 * binary pass through untouched. */
export const encodeRawParam = (dialect: SqlDialect, value: unknown): unknown => {
  if (value === null || value === undefined) {
    return null
  }
  if (value instanceof Date) {
    return dialect.encode('timestamp', value)
  }
  if (typeof value === 'boolean') {
    return dialect.encode('boolean', value)
  }
  if (typeof value === 'object' && !(value instanceof Uint8Array)) {
    return dialect.encode('json', value)
  }
  return value
}

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
