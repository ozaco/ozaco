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
import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

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

const bind = operation(function* (ctx: CompileContext, field: string, value: unknown) {
  ctx.params.push(yield* ctx.dialect.encode(ctx.kinds.get(field) ?? 'json', value))
  return ctx.dialect.placeholder(ctx.params.length)
})

const CMP: Record<string, string> = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

const filterSql = operation(function* (
  ctx: CompileContext,
  filter: Filter,
): Generator<AnyType, string, AnyType> {
  switch (filter.op) {
    case 'eq':
    case 'ne': {
      if (filter.value === null) {
        return `${quoteIdent(filter.field)} IS ${filter.op === 'eq' ? '' : 'NOT '}NULL`
      }
      const placeholder = yield* bind(ctx, filter.field, filter.value)
      return `${quoteIdent(filter.field)} ${CMP[filter.op]} ${placeholder}`
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const placeholder = yield* bind(ctx, filter.field, filter.value)
      return `${quoteIdent(filter.field)} ${CMP[filter.op]} ${placeholder}`
    }
    case 'in':
    case 'not-in': {
      if (filter.values.length === 0) {
        return filter.op === 'in' ? '1 = 0' : '1 = 1'
      }
      const placeholders: string[] = []
      for (const value of filter.values) {
        placeholders.push(yield* bind(ctx, filter.field, value))
      }
      const list = placeholders.join(', ')
      return `${quoteIdent(filter.field)} ${filter.op === 'in' ? 'IN' : 'NOT IN'} (${list})`
    }
    case 'like': {
      const column = quoteIdent(filter.field)
      const pattern = yield* bind(ctx, filter.field, filter.pattern)
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
      const parts: string[] = []
      for (const inner of filter.filters) {
        parts.push(yield* filterSql(ctx, inner))
      }
      return `(${parts.join(filter.op === 'and' ? ' AND ' : ' OR ')})`
    }
    case 'not': {
      return `NOT (${yield* filterSql(ctx, filter.filter)})`
    }
    default: {
      return '1 = 1'
    }
  }
})

const whereSql = operation(function* (ctx: CompileContext, filter: Filter | null) {
  return filter ? ` WHERE ${yield* filterSql(ctx, filter)}` : ''
})

const orderSql = (order: FindSpec['order']): string =>
  order.length === 0
    ? ''
    : ` ORDER BY ${order
        .map(entry => `${quoteIdent(entry.field)} ${entry.direction === 'desc' ? 'DESC' : 'ASC'}`)
        .join(', ')}`

export const compileFind = operation(function* (dialect: SqlDialect, spec: FindSpec) {
  const ctx = contextOf(dialect, spec.table)
  const where = yield* whereSql(ctx, spec.filter)
  const limit = spec.limit === null ? '' : ` LIMIT ${Math.trunc(spec.limit)}`
  const offset = spec.offset ? ` OFFSET ${Math.trunc(spec.offset)}` : ''
  return {
    text: `SELECT * FROM ${quoteIdent(spec.table.name)}${where}${orderSql(spec.order)}${limit}${offset}`,
    params: ctx.params,
  } as Statement
})

export const compileCount = operation(function* (dialect: SqlDialect, spec: CountSpec) {
  const ctx = contextOf(dialect, spec.table)
  const where = yield* whereSql(ctx, spec.filter)
  return {
    text: `SELECT COUNT(*) AS "count" FROM ${quoteIdent(spec.table.name)}${where}`,
    params: ctx.params,
  } as Statement
})

export const compileInsert = operation(function* (
  dialect: SqlDialect,
  table: TableSpec,
  rows: readonly Doc[],
) {
  const ctx = contextOf(dialect, table)
  const columns = Object.keys(rows[0] ?? {})
  const tuples: string[] = []
  for (const row of rows) {
    const placeholders: string[] = []
    for (const column of columns) {
      placeholders.push(yield* bind(ctx, column, row[column] ?? null))
    }
    tuples.push(`(${placeholders.join(', ')})`)
  }
  return {
    text: `INSERT INTO ${quoteIdent(table.name)} (${columns.map(quoteIdent).join(', ')}) VALUES ${tuples.join(', ')} RETURNING *`,
    params: ctx.params,
  } as Statement
})

export const compileUpdate = operation(function* (dialect: SqlDialect, spec: UpdateSpec) {
  const ctx = contextOf(dialect, spec.table)
  const assignments: string[] = []
  for (const [column, value] of Object.entries(spec.set)) {
    assignments.push(`${quoteIdent(column)} = ${yield* bind(ctx, column, value)}`)
  }
  for (const column of spec.bump) {
    assignments.push(`${quoteIdent(column)} = ${quoteIdent(column)} + 1`)
  }
  const where = yield* whereSql(ctx, spec.filter)
  return {
    text: `UPDATE ${quoteIdent(spec.table.name)} SET ${assignments.join(', ')}${where} RETURNING *`,
    params: ctx.params,
  } as Statement
})

export const compileDelete = operation(function* (dialect: SqlDialect, spec: DeleteSpec) {
  const ctx = contextOf(dialect, spec.table)
  const where = yield* whereSql(ctx, spec.filter)
  return {
    text: `DELETE FROM ${quoteIdent(spec.table.name)}${where} RETURNING *`,
    params: ctx.params,
  } as Statement
})
