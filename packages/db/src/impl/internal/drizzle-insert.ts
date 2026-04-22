import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { InsertQuery, InsertReturning } from '../../query'
import type { DbError } from '../../runtime'
import type { InferInsert, InferRow } from '../../schema/infer'
import type { TableDef } from '../../schema/types'

import type { DrizzleRuntime } from './drizzle-base'
import { op, runPromise } from './drizzle-base'
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
        all: () =>
          op<InferRow<TTable>[], DbError>(function* () {
            const drizzleTable = resolveTable(runtime, table)
            if (!drizzleTable) {
              return yield* tableNotFound<InferRow<TTable>[]>(table.name)
            }
            const result = yield* runPromise(() => buildReturning(drizzleTable))
            return result as InferRow<TTable>[]
          }),
        first: () =>
          op<InferRow<TTable> | null, DbError>(function* () {
            const drizzleTable = resolveTable(runtime, table)
            if (!drizzleTable) {
              return yield* tableNotFound<InferRow<TTable> | null>(table.name)
            }
            const result = yield* runPromise(() => buildReturning(drizzleTable))
            return (result as InferRow<TTable>[])[0] ?? null
          }),
        firstOrFail: () =>
          op<InferRow<TTable>, DbError>(function* () {
            const drizzleTable = resolveTable(runtime, table)
            if (!drizzleTable) {
              return yield* tableNotFound<InferRow<TTable>>(table.name)
            }
            const result = yield* runPromise(() => buildReturning(drizzleTable))
            const row = (result as InferRow<TTable>[])[0]
            if (row === undefined) {
              return yield* fail('not-found' as DbError, `insert returned no rows`)
            }
            return row
          }),
      }
    },
    execute: () =>
      op<void, DbError>(function* () {
        const drizzleTable = resolveTable(runtime, table)
        if (!drizzleTable) {
          return yield* tableNotFound<void>(table.name)
        }
        yield* runPromise(() => runtime.db.insert(drizzleTable).values(rows))
      }),
  }

  return chain
}
