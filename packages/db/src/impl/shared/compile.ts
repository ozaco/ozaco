// oxlint-disable import/exports-last
import type { Spec } from 'db:core'
import type { Operation } from 'std:effect'

import type { Sql } from './types'

/** Quote a SQL identifier, doubling embedded quotes — the only injection-safe way to inline one. */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

const builderOf = (dialect: Sql.Dialect, table: Spec.Table): Sql.Builder => ({
  dialect,
  kinds: new Map(table.columns.map(column => [column.name, column.kind])),
  params: [],
})

function* bind(builder: Sql.Builder, field: string, value: unknown) {
  builder.params.push(yield* builder.dialect.encode(builder.kinds.get(field) ?? 'json', value))
  return builder.dialect.placeholder(builder.params.length)
}

const COMPARE: Record<string, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

function* filterSql(builder: Sql.Builder, filter: Spec.Filter): Operation<string> {
  switch (filter.op) {
    case 'eq':
    case 'ne': {
      if (filter.value === null) {
        return `${quoteIdent(filter.field)} IS ${filter.op === 'eq' ? '' : 'NOT '}NULL`
      }

      const placeholder = yield* bind(builder, filter.field, filter.value)

      return `${quoteIdent(filter.field)} ${COMPARE[filter.op]} ${placeholder}`
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const placeholder = yield* bind(builder, filter.field, filter.value)
      return `${quoteIdent(filter.field)} ${COMPARE[filter.op]} ${placeholder}`
    }
    case 'in':
    case 'not-in': {
      if (filter.value.length === 0) {
        return filter.op === 'in' ? '1 = 0' : '1 = 1'
      }

      const placeholders: string[] = []

      for (const value of filter.value) {
        placeholders.push(yield* bind(builder, filter.field, value))
      }

      const keyword = filter.op === 'in' ? 'IN' : 'NOT IN'

      return `${quoteIdent(filter.field)} ${keyword} (${placeholders.join(', ')})`
    }

    case 'like': {
      const column = quoteIdent(filter.field)
      const pattern = yield* bind(builder, filter.field, filter.pattern)

      if (!filter.insensitive) {
        return `${column} LIKE ${pattern}`
      }

      return builder.dialect.ilike
        ? `${column} ${builder.dialect.ilike} ${pattern}`
        : `LOWER(${column}) LIKE LOWER(${pattern})`
    }

    case 'is-null': {
      return `${quoteIdent(filter.field)} IS NULL`
    }

    case 'not-null': {
      return `${quoteIdent(filter.field)} IS NOT NULL`
    }
    case 'and':
    case 'or': {
      if (filter.filters.length === 0) {
        return filter.op === 'and' ? '1 = 1' : '1 = 0'
      }

      const parts: string[] = []

      for (const inner of filter.filters) {
        parts.push(yield* filterSql(builder, inner))
      }

      return `(${parts.join(filter.op === 'and' ? ' AND ' : ' OR ')})`
    }

    case 'not': {
      return `NOT (${yield* filterSql(builder, filter.filter)})`
    }

    default: {
      return '1 = 1'
    }
  }
}

function* whereSql(builder: Sql.Builder, filter: Spec.Filter | null) {
  return filter ? ` WHERE ${yield* filterSql(builder, filter)}` : ''
}

const orderSql = (order: readonly Spec.OrderBy[]): string =>
  order.length === 0
    ? ''
    : ` ORDER BY ${order
        .map(entry => `${quoteIdent(entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`)
        .join(', ')}`

const statement = (text: string, builder: Sql.Builder): Sql.Statement => ({
  text,
  params: builder.params,
})

export function* compileFind(dialect: Sql.Dialect, spec: Spec.Find) {
  const builder = builderOf(dialect, spec.table)
  const where = yield* whereSql(builder, spec.filter)
  const limit = spec.limit === null ? '' : ` LIMIT ${Math.trunc(spec.limit)}`
  const offset = spec.offset ? ` OFFSET ${Math.trunc(spec.offset)}` : ''
  const columns =
    spec.fields && spec.fields.length > 0 ? spec.fields.map(quoteIdent).join(', ') : '*'

  return statement(
    `SELECT ${columns} FROM ${quoteIdent(spec.table.name)}${where}${orderSql(spec.order)}${limit}${offset}`,
    builder,
  )
}

const AGGREGATE: Readonly<Record<Spec.AggregateOp['kind'], string>> = {
  count: 'COUNT',
  sum: 'SUM',
  avg: 'AVG',
  min: 'MIN',
  max: 'MAX',
}

/** `SELECT <group cols>, SUM(x) AS "sum" … GROUP BY <group cols>` — the aggregate plane. */
export function* compileAggregate(dialect: Sql.Dialect, spec: Spec.Aggregate) {
  const builder = builderOf(dialect, spec.table)
  const where = yield* whereSql(builder, spec.filter)

  const selected = [
    ...spec.groupBy.map(field => quoteIdent(field)),

    ...spec.ops.map(op =>
      op.kind === 'count' && op.field === null
        ? `COUNT(*) AS ${quoteIdent(op.as)}`
        : `${AGGREGATE[op.kind]}(${quoteIdent(op.field!)}) AS ${quoteIdent(op.as)}`,
    ),
  ]

  const group =
    spec.groupBy.length === 0 ? '' : ` GROUP BY ${spec.groupBy.map(quoteIdent).join(', ')}`

  return statement(
    `SELECT ${selected.join(', ')} FROM ${quoteIdent(spec.table.name)}${where}${group}`,
    builder,
  )
}

export function* compileCount(dialect: Sql.Dialect, spec: Spec.Count) {
  const builder = builderOf(dialect, spec.table)
  const where = yield* whereSql(builder, spec.filter)

  return statement(
    `SELECT COUNT(*) AS "count" FROM ${quoteIdent(spec.table.name)}${where}`,
    builder,
  )
}

export function* compileInsert(dialect: Sql.Dialect, table: Spec.Table, rows: readonly Spec.Doc[]) {
  const builder = builderOf(dialect, table)
  const columns = Object.keys(rows[0] ?? {})
  const tuples: string[] = []

  for (const row of rows) {
    const placeholders: string[] = []

    for (const column of columns) {
      placeholders.push(yield* bind(builder, column, row[column] ?? null))
    }

    tuples.push(`(${placeholders.join(', ')})`)
  }

  return statement(
    `INSERT INTO ${quoteIdent(table.name)} (${columns.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')} RETURNING *`,
    builder,
  )
}

export function* compileUpdate(dialect: Sql.Dialect, spec: Spec.Update) {
  const builder = builderOf(dialect, spec.table)
  const assignments: string[] = []

  for (const [column, value] of Object.entries(spec.set)) {
    assignments.push(`${quoteIdent(column)} = ${yield* bind(builder, column, value)}`)
  }

  // assignments bind BEFORE the predicate so placeholders stay in statement order
  const where = yield* whereSql(builder, spec.filter)

  return statement(
    `UPDATE ${quoteIdent(spec.table.name)} SET ${assignments.join(', ')}${where} RETURNING *`,
    builder,
  )
}

export function* compileDelete(dialect: Sql.Dialect, spec: Spec.Delete) {
  const builder = builderOf(dialect, spec.table)
  const where = yield* whereSql(builder, spec.filter)

  return statement(`DELETE FROM ${quoteIdent(spec.table.name)}${where} RETURNING *`, builder)
}
