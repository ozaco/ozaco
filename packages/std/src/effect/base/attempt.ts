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

/** Run `op`; a failure is handed to `handler`, whose answer stands in for the value — or, with
 * no handler, becomes `null` (the "this or nothing" read: `recover(() => parse(text))`). The
 * `causes` are appended to the failure before the handler sees it; they ride with a handler only. */
export function recover<T>(op: Operation<T> | (() => Operation<T>)): Operation<T | null>
export function recover<T, R>(
  op: Operation<T> | (() => Operation<T>),
  handler: (failure: Result.Failure<unknown>) => Operation<R>,
  ...causes: string[]
): Operation<T | R>
export function* recover<T, R>(
  op: Operation<T> | (() => Operation<T>),
  handler?: (failure: Result.Failure<unknown>) => Operation<R>,
  ...causes: string[]
): Operation<T | R | null> {
  const result = yield* attempt(op, ...causes)

  if (isSuccess(result)) {
    return result.value
  }

  return handler ? yield* handler(result) : null
}
