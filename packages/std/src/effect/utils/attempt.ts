import type { Result } from 'std:result'
import { asFailure, isSuccess, succeed } from 'std:result'

import type { Operation } from '../types/operation'

export function* attempt<T>(
  op: Operation<T> | (() => Operation<T>),
  ...causes: string[]
): Operation<Result<T, unknown>> {
  try {
    const target = typeof op === 'function' ? op() : op

    return succeed(yield* target) as Result<T, unknown>
  } catch (error) {
    return asFailure(error, ...causes) as Result<T, unknown>
  }
}

export function* recover<T, R>(
  op: Operation<T> | (() => Operation<T>),
  handler: (failure: Result.Failure<unknown>) => Operation<R>,
  ...causes: string[]
): Operation<T | R> {
  const result = yield* attempt(op, ...causes)

  return isSuccess(result) ? result.value : yield* handler(result)
}
