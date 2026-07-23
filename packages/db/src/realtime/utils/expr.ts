// oxlint-disable import/exports-last
import type { FragmentSqlToken, PrimitiveValueExpression } from 'db:core'
import { sql } from 'db:core'

/** A boolean predicate fragment, built on the core `sql` tag (so filters compose into real queries). */
export type Filter = FragmentSqlToken

const ident = (column: string): FragmentSqlToken => sql.fragment`${sql.identifier([column])}`

/** `column = value` (or `IS NULL` when value is null). */
export const eq = (column: string, value: PrimitiveValueExpression): Filter =>
  value === null
    ? sql.fragment`${ident(column)} IS NULL`
    : sql.fragment`${ident(column)} = ${value}`

/** `column <> value` (or `IS NOT NULL` when value is null). */
export const ne = (column: string, value: PrimitiveValueExpression): Filter =>
  value === null
    ? sql.fragment`${ident(column)} IS NOT NULL`
    : sql.fragment`${ident(column)} <> ${value}`

export const gt = (column: string, value: PrimitiveValueExpression): Filter =>
  sql.fragment`${ident(column)} > ${value}`
export const gte = (column: string, value: PrimitiveValueExpression): Filter =>
  sql.fragment`${ident(column)} >= ${value}`
export const lt = (column: string, value: PrimitiveValueExpression): Filter =>
  sql.fragment`${ident(column)} < ${value}`
export const lte = (column: string, value: PrimitiveValueExpression): Filter =>
  sql.fragment`${ident(column)} <= ${value}`
export const like = (column: string, value: PrimitiveValueExpression): Filter =>
  sql.fragment`${ident(column)} LIKE ${value}`

/** Case-insensitive `LIKE` — portable across SQLite + Postgres by lowercasing both sides. */
export const ilike = (column: string, value: PrimitiveValueExpression): Filter =>
  sql.fragment`lower(${ident(column)}) LIKE lower(${value})`

/** `column IN (...values)` (empty list → `FALSE`, so it matches no rows). */
export const inList = (column: string, values: readonly PrimitiveValueExpression[]): Filter =>
  values.length === 0
    ? sql.fragment`FALSE`
    : sql.fragment`${ident(column)} IN (${sql.join(
        values.map(value => sql.fragment`${value}`),
        sql.fragment`, `,
      )})`

/** `column NOT IN (...values)` (empty list → `TRUE`, so it excludes nothing). */
export const notInList = (column: string, values: readonly PrimitiveValueExpression[]): Filter =>
  values.length === 0
    ? sql.fragment`TRUE`
    : sql.fragment`${ident(column)} NOT IN (${sql.join(
        values.map(value => sql.fragment`${value}`),
        sql.fragment`, `,
      )})`

/** Negate a predicate. */
export const not = (predicate: Filter): Filter => sql.fragment`NOT (${predicate})`

/** AND-combine predicates (empty → `TRUE`). */
export const and = (...parts: readonly Filter[]): Filter =>
  parts.length === 0 ? sql.fragment`TRUE` : sql.fragment`(${sql.join(parts, sql.fragment` AND `)})`

/** OR-combine predicates (empty → `FALSE`). */
export const or = (...parts: readonly Filter[]): Filter =>
  parts.length === 0 ? sql.fragment`FALSE` : sql.fragment`(${sql.join(parts, sql.fragment` OR `)})`
