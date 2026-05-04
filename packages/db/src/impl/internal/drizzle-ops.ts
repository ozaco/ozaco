import type { Operation } from 'std:effect'
import { operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { QueryBuilder } from '../../types/query'
import type { DbError } from '../../types/runtime'
import type { SchemaDef } from '../../utils/schema/types'

import type { DrizzleRuntime } from './drizzle-base'
import { runPromise } from './drizzle-base'
import { createInsert } from './drizzle-insert'
import { createSelect } from './drizzle-select'
import { createDelete, createUpdate } from './drizzle-update'

export const createQueryBuilder = (runtime: DrizzleRuntime, schema: SchemaDef): QueryBuilder => {
  const builder: QueryBuilder = {
    from: table => createSelect(runtime, table),
    insert: table => createInsert(runtime, table),
    update: table => createUpdate(runtime, table),
    delete: table => createDelete(runtime, table),

    transaction: operation(function* <T>(
      fn: (tx: QueryBuilder) => Operation<T, unknown | DbError>,
    ) {
      yield* runPromise(() => runtime.execRaw('BEGIN'), runtime)
      try {
        const result = yield* fn(builder)
        yield* runPromise(() => runtime.execRaw('COMMIT'), runtime)
        return result
      } catch (error) {
        yield* runPromise(() => runtime.execRaw('ROLLBACK'), runtime)
        throw error
      }
    }) as AnyType,
    raw: operation(function* <T>(query: string, params: unknown[] = []) {
      const rows = yield* runPromise(() => runtime.execRaw(query, params), runtime)
      return rows as T[]
    }) as AnyType,
  }
  void schema
  return builder
}
