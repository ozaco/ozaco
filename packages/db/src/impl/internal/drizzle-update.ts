import type { AnyType } from 'std:shared'

import type { DeleteQuery, UpdateQuery, UpdateReturning, WhereClause } from '../../query'
import type { DbError } from '../../runtime'
import type { InferRow } from '../../schema/infer'
import type { TableDef } from '../../schema/types'

import type { DrizzleRuntime } from './drizzle-base'
import { extractChangeCount, op, runPromise } from './drizzle-base'
import { buildWhere, resolveTable, tableNotFound } from './drizzle-helpers'

export const createUpdate = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  table: TTable,
): UpdateQuery<TTable> => {
  const state: {
    set: Partial<InferRow<TTable>> | null
    where: WhereClause<TTable> | null
  } = { set: null, where: null }

  const build = (drizzleTable: AnyType) => {
    let query = runtime.db.update(drizzleTable).set(state.set ?? {}) as AnyType
    if (state.where) {
      const whereExpr = buildWhere(runtime, drizzleTable, state.where)
      if (whereExpr !== undefined) {
        query = query.where(whereExpr)
      }
    }
    return query
  }

  const chain: UpdateQuery<TTable> = {
    set(values) {
      state.set = values
      return chain
    },
    where(clause) {
      state.where = clause
      return chain
    },
    returning(): UpdateReturning<TTable> {
      return {
        all: () =>
          op<InferRow<TTable>[], DbError>(function* () {
            const drizzleTable = resolveTable(runtime, table)
            if (!drizzleTable) {
              return yield* tableNotFound<InferRow<TTable>[]>(table.name)
            }
            const rows = yield* runPromise(() => build(drizzleTable).returning())
            return rows as InferRow<TTable>[]
          }),
        first: () =>
          op<InferRow<TTable> | null, DbError>(function* () {
            const drizzleTable = resolveTable(runtime, table)
            if (!drizzleTable) {
              return yield* tableNotFound<InferRow<TTable> | null>(table.name)
            }
            const rows = yield* runPromise(() => build(drizzleTable).returning())
            return (rows as InferRow<TTable>[])[0] ?? null
          }),
      }
    },
    execute: () =>
      op<number, DbError>(function* () {
        const drizzleTable = resolveTable(runtime, table)
        if (!drizzleTable) {
          return yield* tableNotFound<number>(table.name)
        }
        const result = yield* runPromise(() => build(drizzleTable))
        return extractChangeCount(result)
      }),
  }

  return chain
}

export const createDelete = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  table: TTable,
): DeleteQuery<TTable> => {
  const state: { where: WhereClause<TTable> | null } = { where: null }

  const build = (drizzleTable: AnyType) => {
    let query = runtime.db.delete(drizzleTable) as AnyType
    if (state.where) {
      const whereExpr = buildWhere(runtime, drizzleTable, state.where)
      if (whereExpr !== undefined) {
        query = query.where(whereExpr)
      }
    }
    return query
  }

  const chain: DeleteQuery<TTable> = {
    where(clause) {
      state.where = clause
      return chain
    },
    execute: () =>
      op<number, DbError>(function* () {
        const drizzleTable = resolveTable(runtime, table)
        if (!drizzleTable) {
          return yield* tableNotFound<number>(table.name)
        }
        const result = yield* runPromise(() => build(drizzleTable))
        return extractChangeCount(result)
      }),
  }

  return chain
}
