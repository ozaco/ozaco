// oxlint-disable import/exports-last
import type { Helpers } from '../types/helpers'

import { SQLSTATE } from './const'

/** A unique violation said in words, by a driver that hides its SQLSTATE. */
const UNIQUE_TEXT = /unique|duplicate key/iu

/** SQLite's words for a unique violation. */
const SQLITE_UNIQUE_TEXT = /unique constraint failed/iu

/** A status cause read back: `sqlstate 23505`, `sqlite SQLITE_BUSY`. */
const STATUS_CAUSE = /^(?:sqlstate|sqlite) (\S+)$/u

/** A field of a driver error — a throwing getter, or a value that has no fields, reads as
 * `undefined`, so classifying a value never throws. */
const fieldOf = (value: unknown, key: 'code' | 'errno' | 'message'): unknown => {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    return undefined
  }

  try {
    return (value as Readonly<Record<string, unknown>>)[key]
  } catch {
    return undefined
  }
}

/** The code a driver error carries: its SQLSTATE (`errno` on Bun SQL, whose `code` is the generic
 * `ERR_POSTGRES_SERVER_ERROR`; `code` on node-postgres), else its `SQLITE_*` result code. */
export const driverCodeOf = (error: unknown): Helpers.DriverCode | undefined => {
  const code = fieldOf(error, 'code')
  const state = [fieldOf(error, 'errno'), code].find(
    candidate => typeof candidate === 'string' && SQLSTATE.test(candidate),
  )

  if (typeof state === 'string') {
    return { family: 'sqlstate', code: state }
  }

  return typeof code === 'string' && code.startsWith('SQLITE_')
    ? { family: 'sqlite', code }
    : undefined
}

const sqlStateKind = (state: string): Helpers.DriverKind | undefined => {
  switch (state) {
    case '23505': {
      return 'unique'
    }

    case '23503': {
      return 'foreign-key'
    }

    case '23502': {
      return 'not-null'
    }

    case '23514': {
      return 'check'
    }
    case '40001':
    case '40P01': {
      return 'conflict'
    }
    case '57P01':
    case '57P02':
    case '57P03': {
      return 'connection'
    }

    default: {
      return state.startsWith('08') ? 'connection' : undefined
    }
  }
}

const sqliteKind = (code: string): Helpers.DriverKind | undefined => {
  if (code.includes('CONSTRAINT_UNIQUE') || code.includes('CONSTRAINT_PRIMARYKEY')) {
    return 'unique'
  }

  if (code.includes('CONSTRAINT_FOREIGNKEY')) {
    return 'foreign-key'
  }

  if (code.includes('CONSTRAINT_NOTNULL')) {
    return 'not-null'
  }

  if (code.includes('CONSTRAINT_CHECK')) {
    return 'check'
  }

  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' ? 'conflict' : undefined
}

/**
 * What a driver error stands for — by its code first (the SQLSTATE of pg / bun-sql, the
 * `SQLITE_*` code of sqlite), then by its text (a unique violation from a driver that hides the
 * code); `query` for anything else. The ONE classifier behind the `DbErrors` matchers.
 */
export const driverKindOf = (error: unknown): Helpers.DriverKind => {
  const code = driverCodeOf(error)
  const byCode = code && (code.family === 'sqlstate' ? sqlStateKind : sqliteKind)(code.code)

  if (byCode) {
    return byCode
  }

  const message = fieldOf(error, 'message')
  const words = code?.family === 'sqlite' ? SQLITE_UNIQUE_TEXT : UNIQUE_TEXT

  return typeof message === 'string' && words.test(message) ? 'unique' : 'query'
}

/** The `DbErrors` matcher of `kind`: whether {@link driverKindOf} classifies a value as it. */
export const isDriverKind =
  (kind: Helpers.DriverKind) =>
  (error: unknown): boolean =>
    driverKindOf(error) === kind

/** The string cause a driver code travels as — `sqlstate 23505` (pg / bun-sql), `sqlite
 * SQLITE_CONSTRAINT_UNIQUE` (sqlite) — read back by {@link statusCodeIn}. */
export const statusCauseOf = (code: Helpers.DriverCode): string => `${code.family} ${code.code}`

/** The driver code a status cause names (see {@link statusCauseOf}); `undefined` for any other
 * string cause. */
export const statusCodeIn = (cause: string): string | undefined => STATUS_CAUSE.exec(cause)?.[1]
