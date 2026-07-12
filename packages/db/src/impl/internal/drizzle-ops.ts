import type { Operation } from 'std:effect'
import { operation, run, until } from 'std:effect'
import { isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { QueryBuilder } from '../../types/query'
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

    transaction: operation(function* <T>(fn: (tx: QueryBuilder) => Operation<T>) {
      // Pin ONE connection for the whole transaction via drizzle's `db.transaction`: the inner query
      // builder runs on the transaction-scoped `txDb`, so the queries share the connection that issued
      // BEGIN and gets COMMIT/ROLLBACK. The old hand-rolled BEGIN/COMMIT over `execRaw` drew arbitrary
      // pooled connections in autocommit mode — zero atomicity. A Result.Failure from `fn` throws so
      // drizzle rolls back; `until` re-surfaces it as the transaction's failure.
      return yield* until(
        runtime.db.transaction(async (txDb: AnyType) => {
          const txBuilder = createQueryBuilder({ ...runtime, db: txDb }, schema)
          const outcome = await run(() => fn(txBuilder))
          if (isSuccess(outcome)) {
            return outcome.value
          }
          throw outcome
        }),
      )
    }) as AnyType,
    raw: operation(function* <T>(query: string, params: unknown[] = []) {
      const rows = yield* runPromise(() => runtime.execRaw(query, params), runtime)
      return rows as T[]
    }) as AnyType,
  }
  void schema
  return builder
}
