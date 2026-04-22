import type { Operation } from 'std:effect'

import type { QueryBuilder } from '../../query'
import type { DbError } from '../../runtime'
import type { SchemaDef } from '../../schema/types'

import type { DrizzleRuntime } from './drizzle-base'
import { op, runPromise } from './drizzle-base'
import { createInsert } from './drizzle-insert'
import { createSelect } from './drizzle-select'
import { createDelete, createUpdate } from './drizzle-update'

export const createQueryBuilder = (runtime: DrizzleRuntime, schema: SchemaDef): QueryBuilder => {
  const builder: QueryBuilder = {
    from: table => createSelect(runtime, table),
    insert: table => createInsert(runtime, table),
    update: table => createUpdate(runtime, table),
    delete: table => createDelete(runtime, table),
    transaction: <T, E = never>(fn: (tx: QueryBuilder) => Operation<T, E | DbError>) =>
      op<T, E | DbError>(function* () {
        yield* runPromise(() => runtime.execRaw('BEGIN'))
        try {
          const result = yield* fn(builder)
          yield* runPromise(() => runtime.execRaw('COMMIT'))
          return result
        } catch (error) {
          yield* runPromise(() => runtime.execRaw('ROLLBACK'))
          throw error
        }
      }),
    raw: <T = unknown>(query: string, params: unknown[] = []) =>
      op<T[], DbError>(function* () {
        const rows = yield* runPromise(() => runtime.execRaw(query, params))
        return rows as T[]
      }),
  }
  void schema
  return builder
}
