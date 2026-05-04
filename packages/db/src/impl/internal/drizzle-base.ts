import type { ManualOperation } from 'std:effect'
import { operation, until } from 'std:effect'
import type { Failure } from 'std:result'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { DbError } from '../../types/runtime'

export type DrizzleTableMap = Record<string, AnyType>

export interface DrizzleRuntime {
  readonly db: AnyType
  readonly tables: DrizzleTableMap
  readonly and: (...conditions: AnyType[]) => AnyType
  readonly eq: (column: AnyType, value: unknown) => AnyType
  readonly asc: (column: AnyType) => AnyType
  readonly desc: (column: AnyType) => AnyType
  readonly execRaw: (sql: string, params?: unknown[]) => Promise<unknown[]>
  /** Driver-specific error classifier; default is the generic Driver fallback. */
  readonly classify?: (raw: unknown) => Failure<DbError>
}

export const runPromise = operation(function* <T>(
  fn: () => Promise<T>,
  runtime?: Pick<DrizzleRuntime, 'classify'>,
): ManualOperation<T, DbError> {
  try {
    const outcome = yield* until(fn())

    return outcome
  } catch (error) {
    const failure = asFailure<DbError>(error as AnyType)

    if (runtime?.classify) {
      return yield* runtime.classify(failure)
    }

    return yield* failure
  }
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
