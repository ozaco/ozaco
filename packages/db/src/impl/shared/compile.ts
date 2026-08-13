// oxlint-disable import/exports-last
import type {
  ColumnKind,
  CountSpec,
  DeleteSpec,
  Doc,
  Filter,
  FindSpec,
  TableSpec,
  UpdateSpec,
} from 'db:core'

import type { SqlDialect, Statement } from './types'

/** Quote a SQL identifier, doubling embedded quotes — the only injection-safe way to inline one. */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`

interface CompileContext {
  readonly dialect: SqlDialect
  readonly kinds: ReadonlyMap<string, ColumnKind>
  readonly params: unknown[]
}

const contextOf = (dialect: SqlDialect, table: TableSpec): CompileContext => ({
  dialect,
  kinds: new Map(table.columns.map(column => [column.name, column.kind])),
  params: [],
})

const bind = (ctx: CompileContext, field: string, value: unknown): string => {
  ctx.params.push(ctx.dialect.encode(ctx.kinds.get(field) ?? 'json', value))
  return ctx.dialect.placeholder(ctx.params.length)
}

const CMP: Record<string, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

const filterSql = (ctx: CompileContext, filter: Filter): string => {
  switch (filter.op) {
    case 'eq':
    case 'ne': {
      if (filter.value === null) {
        return `${quoteIdent(filter.field)} IS ${filter.op === 'eq' ? '' : 'NOT '}NULL`
      }
      return `${quoteIdent(filter.field)} ${CMP[filter.op]} ${bind(ctx, filter.field, filter.value)}`
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      return `${quoteIdent(filter.field)} ${CMP[filter.op]} ${bind(ctx, filter.field, filter.value)}`
    }
    case 'in':
    case 'not-in': {
      if (filter.values.length === 0) {
        return filter.op === 'in' ? '1 = 0' : '1 = 1'
      }
      const list = filter.values.map(value => bind(ctx, filter.field, value)).join(', ')
      return `${quoteIdent(filter.field)} ${filter.op === 'in' ? 'IN' : 'NOT IN'} (${list})`
    }
    case 'like': {
      const column = quoteIdent(filter.field)
      const pattern = bind(ctx, filter.field, filter.pattern)
      if (!filter.insensitive) {
        return `${column} LIKE ${pattern}`
      }
      return ctx.dialect.ilike
        ? `${column} ${ctx.dialect.ilike} ${pattern}`
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
      const glue = filter.op === 'and' ? ' AND ' : ' OR '
      return `(${filter.filters.map(inner => filterSql(ctx, inner)).join(glue)})`
    }
    case 'not': {
      return `NOT (${filterSql(ctx, filter.filter)})`
    }
    default: {
      return '1 = 1'
    }
  }
}

const whereSql = (ctx: CompileContext, filter: Filter | null): string =>
  filter ? ` WHERE ${filterSql(ctx, filter)}` : ''

const orderSql = (order: FindSpec['order']): string =>
  order.length === 0
    ? ''
    : ` ORDER BY ${order
        .map(entry => `${quoteIdent(entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`)
        .join(', ')}`

export const compileFind = (dialect: SqlDialect, spec: FindSpec): Statement => {
  const ctx = contextOf(dialect, spec.table)
  const limit = spec.limit === null ? '' : ` LIMIT ${Math.trunc(spec.limit)}`
  const offset = spec.offset ? ` OFFSET ${Math.trunc(spec.offset)}` : ''
  return {
    text: `SELECT * FROM ${quoteIdent(spec.table.name)}${whereSql(ctx, spec.filter)}${orderSql(spec.order)}${limit}${offset}`,
    params: ctx.params,
  }
}

export const compileCount = (dialect: SqlDialect, spec: CountSpec): Statement => {
  const ctx = contextOf(dialect, spec.table)
  return {
    text: `SELECT COUNT(*) AS "count" FROM ${quoteIdent(spec.table.name)}${whereSql(ctx, spec.filter)}`,
    params: ctx.params,
  }
}

export const compileInsert = (
  dialect: SqlDialect,
  table: TableSpec,
  rows: readonly Doc[],
): Statement => {
  const ctx = contextOf(dialect, table)
  const columns = Object.keys(rows[0] ?? {})
  const tuples = rows
    .map(row => `(${columns.map(column => bind(ctx, column, row[column] ?? null)).join(', ')})`)
    .join(', ')
  return {
    text: `INSERT INTO ${quoteIdent(table.name)} (${columns.map(quoteIdent).join(', ')}) VALUES ${tuples} RETURNING *`,
    params: ctx.params,
  }
}

export const compileUpdate = (dialect: SqlDialect, spec: UpdateSpec): Statement => {
  const ctx = contextOf(dialect, spec.table)
  const assignments = [
    ...Object.entries(spec.set).map(
      ([column, value]) => `${quoteIdent(column)} = ${bind(ctx, column, value)}`,
    ),
    ...spec.bump.map(column => `${quoteIdent(column)} = ${quoteIdent(column)} + 1`),
  ]
  return {
    text: `UPDATE ${quoteIdent(spec.table.name)} SET ${assignments.join(', ')}${whereSql(ctx, spec.filter)} RETURNING *`,
    params: ctx.params,
  }
}

export const compileDelete = (dialect: SqlDialect, spec: DeleteSpec): Statement => {
  const ctx = contextOf(dialect, spec.table)
  return {
    text: `DELETE FROM ${quoteIdent(spec.table.name)}${whereSql(ctx, spec.filter)} RETURNING *`,
    params: ctx.params,
  }
}
