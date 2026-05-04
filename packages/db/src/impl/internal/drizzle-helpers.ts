import type { ManualOperation } from 'std:effect'
import { operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { DbErrorCode } from '../../error-codes'
import type { WhereClause } from '../../types/query'
import type { DbError } from '../../types/runtime'
import type { TableDef } from '../../utils/schema/types'

import type { DrizzleRuntime } from './drizzle-base'

export const resolveTable = (runtime: DrizzleRuntime, table: TableDef): AnyType | null =>
  runtime.tables[table.name] ?? null

export const tableNotFound = operation(function* <T>(name: string): ManualOperation<T, DbError> {
  return yield* fail(DbErrorCode.Driver, `table "${name}" not registered in driver schema`)
})

export const buildWhere = <TTable extends TableDef>(
  runtime: DrizzleRuntime,
  drizzleTable: AnyType,
  clause: WhereClause<TTable>,
): AnyType => {
  const parts: AnyType[] = []
  for (const key of Object.keys(clause) as (keyof WhereClause<TTable>)[]) {
    const column = drizzleTable[key as string]
    if (!column) {
      continue
    }
    parts.push(runtime.eq(column, (clause as Record<string, unknown>)[key as string]))
  }
  if (parts.length === 0) {
    return undefined
  }
  if (parts.length === 1) {
    return parts[0]
  }
  return runtime.and(...parts)
}
