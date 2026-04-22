import type { Operation } from 'std:effect'
import { call, operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { DbError } from '../../runtime'
import { classifyDriverError } from '../../runtime'

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }

export type DrizzleTableMap = Record<string, AnyType>

export interface DrizzleRuntime {
  readonly db: AnyType
  readonly tables: DrizzleTableMap
  readonly and: (...conditions: AnyType[]) => AnyType
  readonly eq: (column: AnyType, value: unknown) => AnyType
  readonly asc: (column: AnyType) => AnyType
  readonly desc: (column: AnyType) => AnyType
  readonly execRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>
}

export const op = <T, E = never>(fn: () => Generator<AnyType, T, unknown>): Operation<T, E> =>
  (operation(fn as AnyType) as () => Operation<T, E>)()

export const runPromise = <T>(fn: () => Promise<T>): Operation<T, DbError> =>
  op<T, DbError>(function* () {
    const outcome: Outcome<T> = yield* call(
      (): Promise<Outcome<T>> =>
        fn().then(
          (value): Outcome<T> => ({ ok: true, value }),
          (error): Outcome<T> => ({ ok: false, error }),
        ),
    )
    if (!outcome.ok) {
      const classified = classifyDriverError(outcome.error)
      yield* fail(classified.kind, classified.message)
      throw new Error('unreachable')
    }
    return outcome.value
  })

export const extractChangeCount = (result: unknown): number => {
  if (typeof result === 'number') {
    return result
  }
  if (result && typeof result === 'object') {
    const record = result as { changes?: number; rowCount?: number | null; rowsAffected?: number }
    return record.changes ?? record.rowCount ?? record.rowsAffected ?? 0
  }
  return 0
}
