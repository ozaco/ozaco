// oxlint-disable import/exports-last
import type { FragmentSqlToken } from 'db:core'
import { sql } from 'db:core'
import { attempt, operation } from 'std:effect'
import { isSuccess } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { CREATED, VERSION } from '../const'
import type { Column, ColumnKind } from '../schema/types'
import type { Row } from '../types/database'

export const ident = (name: string): FragmentSqlToken => sql.fragment`${sql.identifier([name])}`

export const commaList = (parts: readonly FragmentSqlToken[]): FragmentSqlToken =>
  sql.fragment`${sql.join(parts, sql.fragment`, `)}`

/** Decode one stored value back to its native shape by column kind. Booleans arrive as 0/1 on SQLite;
 * a `json` column is stored as text on SQLite (Postgres returns it already parsed) and is decoded
 * through the installed codec — never a bare `JSON.parse`. Invalid JSON falls back to the raw string. */
const decode = operation(function* (kind: ColumnKind, value: unknown) {
  if (value === null || value === undefined) {
    return value
  }
  if (kind === 'boolean') {
    return typeof value === 'number' ? value !== 0 : Boolean(value)
  }
  if (kind === 'json' && typeof value === 'string') {
    const parsed = yield* attempt(JsonCodec.actions.parse(value))
    return isSuccess(parsed) ? parsed.value : value
  }
  return value
})

/** Bring system fields back to numbers (Postgres BIGINT arrives as a string) and decode user columns
 * by their declared kind (`json` via the codec). */
export const coerceRow = operation(function* (row: Row | null, columns: readonly Column[]) {
  if (!row) {
    return row
  }
  const out: Row = { ...row }
  if (out[CREATED] !== undefined) {
    out[CREATED] = Number(out[CREATED])
  }
  if (out[VERSION] !== undefined) {
    out[VERSION] = Number(out[VERSION])
  }
  for (const column of columns) {
    if (column.name in out) {
      out[column.name] = yield* decode(column.kind, out[column.name])
    }
  }
  return out
})

/** Decode a list of rows (see {@link coerceRow}). */
export const coerceRows = operation(function* (rows: readonly Row[], columns: readonly Column[]) {
  const out: Row[] = []
  for (const row of rows) {
    out.push((yield* coerceRow(row, columns)) as Row)
  }
  return out
})
