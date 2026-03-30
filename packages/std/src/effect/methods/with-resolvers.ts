import type { Result } from 'std:result'
import { fail, isSuccess, succeed } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { action } from './action'

export const withResolvers = <T>(cause?: string): Helpers.WithResolvers<T> => {
  const continuations = new Set<(result: Result<T, unknown>) => void>()
  let result: Result<T, unknown> | undefined = undefined

  const operation: Operation<T> = action<T>(function (resolve, reject) {
    const settle = (outcome: Result<T, unknown>) => {
      if (isSuccess(outcome)) {
        resolve(outcome.value)
      } else {
        reject(outcome.error)
      }
    }

    if (result) {
      settle(result)
      return () => {}
    }
    continuations.add(settle)
    return () => continuations.delete(settle)
  }, cause)

  const settle = (outcome: Result<T, unknown>) => {
    if (!result) {
      result = outcome
    }
    for (const continuation of continuations) {
      continuation(result)
    }
  }

  const resolve = (value: T) => settle(succeed(value) as Result<T, never>)
  const reject = (error: unknown) => settle(fail(error))

  return { operation, resolve, reject }
}
