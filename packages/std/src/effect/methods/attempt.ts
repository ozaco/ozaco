import type { Result } from 'std:result'
import { asFailure, isSuccess, succeed } from 'std:result'

import type { Operation } from '../types/operation'

import { isOperation } from './is'

export function* attempt<T, E = unknown>(
  op: Operation<T, E> | (() => Operation<T, E>),
): Operation<Result<T, E>> {
  try {
    const result = isOperation(op)
      ? yield* op as Operation<T, never>
      : yield* (op as () => Operation<T, never>)()

    return succeed(result) as Result<T, E>
  } catch (error) {
    return asFailure(error) as Result<T, E>
  }
}

export function* recover<T, R, E = unknown>(
  op: Operation<T, E> | (() => Operation<T, E>),
  handler: (failure: Result.Failure<E>) => Operation<R>,
): Operation<T | R> {
  const result = yield* attempt(op)

  return isSuccess(result) ? result.value : yield* handler(result)
}
