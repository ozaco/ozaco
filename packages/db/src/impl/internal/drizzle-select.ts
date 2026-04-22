import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { SelectQuery, WhereClause } from '../../query'
import type { DbError } from '../../runtime'
import type { InferRow } from '../../schema/infer'
import type { TableDef } from '../../schema/types'

import type { DrizzleRuntime } from './drizzle-base'
import { op, runPromise } from './drizzle-base'
import { buildWhere, resolveTable, tableNotFound } from './drizzle-helpers'

export const createSelect = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  table: TTable,
): SelectQuery<TTable> => {
  const state: {
    where: WhereClause<TTable> | null
    limit: number | null
    offset: number | null
    orderBy: Array<{ column: string; direction: 'asc' | 'desc' }>
  } = { where: null, limit: null, offset: null, orderBy: [] }

  const build = (drizzleTable: AnyType) => {
    let query = runtime.db.select().from(drizzleTable) as AnyType
    if (state.where) {
      const whereExpr = buildWhere(runtime, drizzleTable, state.where)
      if (whereExpr !== undefined) {
        query = query.where(whereExpr)
      }
    }
    if (state.orderBy.length > 0) {
      const orderExprs = state.orderBy.map(o =>
        o.direction === 'desc'
          ? runtime.desc(drizzleTable[o.column])
          : runtime.asc(drizzleTable[o.column]),
      )
      query = query.orderBy(...orderExprs)
    }
    if (state.limit !== null) {
      query = query.limit(state.limit)
    }
    if (state.offset !== null) {
      query = query.offset(state.offset)
    }
    return query
  }

  const chain: SelectQuery<TTable> = {
    where(clause) {
      state.where = clause
      return chain
    },
    limit(count) {
      state.limit = count
      return chain
    },
    offset(count) {
      state.offset = count
      return chain
    },
    orderBy(column, direction = 'asc') {
      state.orderBy.push({ column: column as string, direction })
      return chain
    },
    all: () =>
      op<InferRow<TTable>[], DbError>(function* () {
        const drizzleTable = resolveTable(runtime, table)
        if (!drizzleTable) {
          return yield* tableNotFound<InferRow<TTable>[]>(table.name)
        }
        const rows = yield* runPromise(() => build(drizzleTable))
        return rows as InferRow<TTable>[]
      }),
    first: () =>
      op<InferRow<TTable> | null, DbError>(function* () {
        const drizzleTable = resolveTable(runtime, table)
        if (!drizzleTable) {
          return yield* tableNotFound<InferRow<TTable> | null>(table.name)
        }
        const rows = yield* runPromise(() => build(drizzleTable).limit(1))
        return (rows as InferRow<TTable>[])[0] ?? null
      }),
    firstOrFail: () =>
      op<InferRow<TTable>, DbError>(function* () {
        const drizzleTable = resolveTable(runtime, table)
        if (!drizzleTable) {
          return yield* tableNotFound<InferRow<TTable>>(table.name)
        }
        const rows = yield* runPromise(() => build(drizzleTable).limit(1))
        const row = (rows as InferRow<TTable>[])[0]
        if (row === undefined) {
          return yield* fail('not-found' as DbError, `no rows in ${table.name}`)
        }
        return row
      }),
  }

  return chain
}
