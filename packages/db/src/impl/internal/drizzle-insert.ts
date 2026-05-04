import { operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbErrorCode } from '../../error-codes'
import type { InsertQuery, InsertReturning } from '../../types/query'
import type { InferInsert, InferRow } from '../../utils/schema/infer'
import type { TableDef } from '../../utils/schema/types'

import type { DrizzleRuntime } from './drizzle-base'
import { runPromise } from './drizzle-base'
import { resolveTable, tableNotFound } from './drizzle-helpers'

export const createInsert = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  table: TTable,
): InsertQuery<TTable> => {
  const rows: InferInsert<TTable>[] = []

  const buildReturning = (drizzleTable: AnyType) =>
    runtime.db.insert(drizzleTable).values(rows).returning()

  const chain: InsertQuery<TTable> = {
    values(row) {
      rows.push(row)
      return chain
    },
    valuesMany(many) {
      rows.push(...many)
      return chain
    },
    returning(): InsertReturning<TTable> {
      return {
        all: operation(function* () {
          const drizzleTable = resolveTable(runtime, table)
          if (!drizzleTable) {
            return yield* tableNotFound<InferRow<TTable>[]>(table.name)
          }
          const result = yield* runPromise(() => buildReturning(drizzleTable), runtime)
          return result as InferRow<TTable>[]
        }),
        first: operation(function* () {
          const drizzleTable = resolveTable(runtime, table)
          if (!drizzleTable) {
            return yield* tableNotFound<InferRow<TTable> | null>(table.name)
          }
          const result = yield* runPromise(() => buildReturning(drizzleTable), runtime)
          return (result as InferRow<TTable>[])[0] ?? null
        }),
        firstOrFail: operation(function* () {
          const drizzleTable = resolveTable(runtime, table)
          if (!drizzleTable) {
            return yield* tableNotFound<InferRow<TTable>>(table.name)
          }
          const result = yield* runPromise(() => buildReturning(drizzleTable), runtime)
          const row = (result as InferRow<TTable>[])[0]
          if (row === undefined) {
            return yield* fail(DbErrorCode.NotFound, `insert returned no rows`)
          }
          return row
        }),
      }
    },
    execute: operation(function* () {
      const drizzleTable = resolveTable(runtime, table)
      if (!drizzleTable) {
        return yield* tableNotFound<void>(table.name)
      }
      yield* runPromise(() => runtime.db.insert(drizzleTable).values(rows), runtime)
    }),
  }

  return chain
}
