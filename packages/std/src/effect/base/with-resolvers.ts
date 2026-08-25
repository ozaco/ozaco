import type { Result } from 'std:result'
import { asFailure, isSuccess, succeed } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { action } from './action'

/**
 * Create an {@link Operation} and two functions to resolve or reject it — the effect equivalent of
 * `Promise.withResolvers()`. No matter how many times the operation is yielded to, it always
 * produces the same outcome.
 */
export function withResolvers<T>(cause?: string): Helpers.WithResolvers<T> {
  const continuations = new Set<(result: Result<T>) => void>()
  let result: Result<T> | undefined = undefined

  const operation: Operation<T> = action<T>((resolve, reject) => {
    const settle = (outcome: Result<T>) => {
      if (isSuccess(outcome)) {
        resolve(outcome.value)
      } else {
        // hand over the Failure itself — asFailure() passes it through, keeping the failure intact
        reject(outcome)
      }
    }

    if (result) {
      settle(result)
      return () => {}
    }

    continuations.add(settle)
    return () => continuations.delete(settle)
  }, cause)

  const settle = (outcome: Result<T>) => {
    if (!result) {
      result = outcome
    }
    for (const continuation of continuations) {
      continuation(result)
    }
  }

  const resolve = (value: T) => settle(succeed(value) as Result.Success<T>)
  const reject = (error: unknown) => settle(asFailure(error))

  return { operation, resolve, reject }
}
