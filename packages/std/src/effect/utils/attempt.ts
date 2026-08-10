import type { Result } from 'std:result'
import { asFailure, isSuccess, succeed } from 'std:result'

import type { Operation } from '../types/operation'

import { isOperation } from './is'

export function* attempt<T>(
  op: Operation<T> | (() => Operation<T>),
  ...causes: string[]
): Operation<Result<T, unknown>> {
  try {
    const result = isOperation(op) ? yield* op : yield* op()

    return succeed(result) as Result<T, unknown>
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
