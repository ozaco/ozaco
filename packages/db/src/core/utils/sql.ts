// oxlint-disable import/exports-last
import type { ZodType } from 'zod'

import {
  ARRAY_TOKEN,
  BINARY_TOKEN,
  DATE_TOKEN,
  FRAGMENT_TOKEN,
  IDENTIFIER_TOKEN,
  INTERVAL_TOKEN,
  JSON_BINARY_TOKEN,
  JSON_TOKEN,
  LIST_TOKEN,
  QUERY_TOKEN,
  TIMESTAMP_TOKEN,
  UNNEST_TOKEN,
  UNSAFE_TOKEN,
} from '../const'
import type {
  ArraySqlToken,
  BinarySqlToken,
  DateSqlToken,
  FragmentSqlToken,
  IdentifierSqlToken,
  IntervalInput,
  IntervalSqlToken,
  JsonSqlToken,
  ListSqlToken,
  PrimitiveValueExpression,
  QueryResultRow,
  QuerySqlToken,
  SerializableValue,
  SqlToken,
  TimestampSqlToken,
  UnnestSqlToken,
  UnsafeSqlToken,
  ValueExpression,
} from '../types'

// --- identifier / type quoting --------------------------------------------------------------------

/** Quote a SQL identifier, doubling embedded quotes. The only injection-safe way to inline a name. */
export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`

const quoteTypeName = (type: string): string =>
  // a type may be schema-qualified (`public.foo`) or an array (`int4[]`); quote each identifier part
  type.replace(/\[\]$/u, '').split('.').map(quoteIdentifier).join('.') +
  (type.endsWith('[]') ? '[]' : '')

const SLONIK_TOKEN_PREFIX = 'SLONIK_TOKEN_'

/** Structural guard: is a `${...}` interpolation a token (vs. a bound primitive)? */
export const isSqlToken = (value: unknown): value is SqlToken =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { type?: unknown }).type === 'string' &&
  (value as { type: string }).type.startsWith(SLONIK_TOKEN_PREFIX)

// --- interpretation (token tree → { sql, values }) ------------------------------------------------

interface BindContext {
  readonly values: PrimitiveValueExpression[]
}

const bindValue = (context: BindContext, value: PrimitiveValueExpression): string => {
  context.values.push(value)
  return `$${context.values.length}`
}

/** Splice a already-baked fragment/query (`$1..$n` relative to its own values) into the outer
 * context, re-numbering its placeholders to freshly allocated ones. */
const spliceFragment = (
  context: BindContext,
  sql: string,
  values: readonly PrimitiveValueExpression[],
): string =>
  sql.replaceAll(/\$(\d+)/gu, (_match, index: string) =>
    bindValue(context, values[Number(index) - 1]!),
  )

const escapeLiteral = (value: PrimitiveValueExpression): string => {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  if (typeof value === 'number') {
    return String(value)
  }
  return `'${String(value).replaceAll("'", "''")}'`
}

const interpretInterval = (input: IntervalInput): string => {
  const parts = [
    input.years ? `${input.years} years` : undefined,
    input.months ? `${input.months} months` : undefined,
    input.days ? `${input.days} days` : undefined,
    input.hours ? `${input.hours} hours` : undefined,
    input.minutes ? `${input.minutes} minutes` : undefined,
    input.seconds ? `${input.seconds} seconds` : undefined,
  ].filter((part): part is string => Boolean(part))
  return parts.length > 0 ? parts.join(' ') : '0 seconds'
}

const interpretToken = (context: BindContext, token: SqlToken): string => {
  switch (token.type) {
    case FRAGMENT_TOKEN:
    case QUERY_TOKEN: {
      return spliceFragment(context, token.sql, token.values)
    }
    case IDENTIFIER_TOKEN: {
      return token.names.map(quoteIdentifier).join('.')
    }
    case UNSAFE_TOKEN: {
      return token.sql
    }
    case LIST_TOKEN: {
      const glue = interpretToken(context, token.glue)
      return token.members.map(member => interpretValue(context, member)).join(glue)
    }
    case ARRAY_TOKEN: {
      const placeholder = bindValue(context, token.values)
      const type =
        typeof token.memberType === 'string'
          ? quoteTypeName(token.memberType)
          : interpretToken(context, token.memberType)
      return `${placeholder}::${type}[]`
    }
    case UNNEST_TOKEN: {
      const columns = token.columnTypes.map((columnType, columnIndex) => {
        const columnValues = token.tuples.map(tuple => tuple[columnIndex]!)
        const placeholder = bindValue(context, columnValues)
        const type =
          typeof columnType === 'string'
            ? quoteTypeName(columnType)
            : interpretToken(context, columnType)
        return `${placeholder}::${type}[]`
      })
      return `unnest(${columns.join(', ')})`
    }
    case JSON_TOKEN: {
      return `${bindValue(context, JSON.stringify(token.value))}::json`
    }
    case JSON_BINARY_TOKEN: {
      return `${bindValue(context, JSON.stringify(token.value))}::jsonb`
    }
    case BINARY_TOKEN: {
      return `${bindValue(context, token.data)}::bytea`
    }
    case DATE_TOKEN: {
      return `${bindValue(context, token.date.toISOString().slice(0, 10))}::date`
    }
    case TIMESTAMP_TOKEN: {
      return `${bindValue(context, token.date.toISOString())}::timestamptz`
    }
    case INTERVAL_TOKEN: {
      return `${bindValue(context, interpretInterval(token.interval))}::interval`
    }
    default: {
      return ''
    }
  }
}

const interpretValue = (context: BindContext, value: ValueExpression): string =>
  isSqlToken(value) ? interpretToken(context, value) : bindValue(context, value)

const bake = (
  parts: TemplateStringsArray,
  values: readonly ValueExpression[],
): { sql: string; values: readonly PrimitiveValueExpression[] } => {
  const context: BindContext = { values: [] }
  let sql = parts[0] ?? ''
  for (let index = 0; index < values.length; index += 1) {
    sql += interpretValue(context, values[index]!) + (parts[index + 1] ?? '')
  }
  return { sql, values: context.values }
}

// --- the `sql` tag + helpers ----------------------------------------------------------------------

/** The `sql` tagged-template and its helpers — the effect-native port of Slonik's `sql-tag`. */
export interface SqlTag {
  <Row extends QueryResultRow = QueryResultRow>(
    parts: TemplateStringsArray,
    ...values: ValueExpression[]
  ): QuerySqlToken<Row>
  /** A validated query: each result row is parsed by `schema` (fails `DbError.DataIntegrity` on
   * mismatch when executed). */
  type<Row extends QueryResultRow>(
    schema: ZodType<Row>,
  ): (parts: TemplateStringsArray, ...values: ValueExpression[]) => QuerySqlToken<Row>
  /** An untyped query (result rows are not validated). */
  unsafe(parts: TemplateStringsArray, ...values: ValueExpression[]): QuerySqlToken
  /** A reusable, parameterized fragment for interpolation into other queries. */
  fragment(parts: TemplateStringsArray, ...values: ValueExpression[]): FragmentSqlToken
  identifier(names: readonly string[]): IdentifierSqlToken
  join(members: readonly ValueExpression[], glue: FragmentSqlToken): ListSqlToken
  array(
    values: readonly PrimitiveValueExpression[],
    memberType: string | FragmentSqlToken,
  ): ArraySqlToken
  unnest(
    tuples: ReadonlyArray<readonly PrimitiveValueExpression[]>,
    columnTypes: ReadonlyArray<string | FragmentSqlToken>,
  ): UnnestSqlToken
  json(value: SerializableValue): JsonSqlToken
  jsonb(value: SerializableValue): JsonSqlToken
  binary(data: Uint8Array): BinarySqlToken
  date(date: Date): DateSqlToken
  timestamp(date: Date): TimestampSqlToken
  interval(input: IntervalInput): IntervalSqlToken
  /** Inline an escaped literal directly into the SQL text (no parameter). Prefer bound values. */
  literalValue(value: PrimitiveValueExpression): UnsafeSqlToken
}

const query = <Row extends QueryResultRow>(
  parts: TemplateStringsArray,
  values: readonly ValueExpression[],
  parser: ZodType<Row> | null,
): QuerySqlToken<Row> => {
  const baked = bake(parts, values)
  return { type: QUERY_TOKEN, sql: baked.sql, values: baked.values, parser }
}

const base = (<Row extends QueryResultRow>(
  parts: TemplateStringsArray,
  ...values: ValueExpression[]
): QuerySqlToken<Row> => query<Row>(parts, values, null)) as SqlTag

base.type =
  <Row extends QueryResultRow>(schema: ZodType<Row>) =>
  (parts: TemplateStringsArray, ...values: ValueExpression[]): QuerySqlToken<Row> =>
    query<Row>(parts, values, schema)

base.unsafe = (parts, ...values) => query(parts, values, null)

base.fragment = (parts, ...values): FragmentSqlToken => {
  const baked = bake(parts, values)
  return { type: FRAGMENT_TOKEN, sql: baked.sql, values: baked.values }
}

base.identifier = names => ({ type: IDENTIFIER_TOKEN, names })
base.join = (members, glue) => ({ type: LIST_TOKEN, members, glue })
base.array = (values, memberType) => ({ type: ARRAY_TOKEN, values, memberType })
base.unnest = (tuples, columnTypes) => ({ type: UNNEST_TOKEN, tuples, columnTypes })
base.json = value => ({ type: JSON_TOKEN, value })
base.jsonb = value => ({ type: JSON_BINARY_TOKEN, value })
base.binary = data => ({ type: BINARY_TOKEN, data })
base.date = date => ({ type: DATE_TOKEN, date })
base.timestamp = date => ({ type: TIMESTAMP_TOKEN, date })
base.interval = input => ({ type: INTERVAL_TOKEN, interval: input })
base.literalValue = value => ({ type: UNSAFE_TOKEN, sql: escapeLiteral(value) })

export const sql: SqlTag = base
