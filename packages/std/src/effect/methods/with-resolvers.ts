import { fail, isSuccess, succeed, type Result } from 'std:result'
import type { Operation } from '../types/operation'

import { action } from './action'
import type { Helpers } from '../types/helpers'

export const withResolvers = <T>(description?: string): Helpers.WithResolvers<T> => {
  let continuations = new Set<(result: Result<T, unknown>) => void>()
  let result: Result<T, unknown> | undefined = undefined

  let operation: Operation<T> = action<T>(function (resolve, reject) {
    let settle = (outcome: Result<T, unknown>) => {
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
  }, description)

  let settle = (outcome: Result<T, unknown>) => {
    if (!result) {
      result = outcome
    }
    for (let continuation of continuations) {
      continuation(result)
    }
  }

  let resolve = (value: T) => settle(succeed(value) as Result<T, never>)
  let reject = (error: unknown) => settle(fail(error))

  return { operation, resolve, reject }
}
