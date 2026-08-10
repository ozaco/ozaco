import type { Result } from 'std:result'
import { isSuccess } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

/** Perform a single Effect as an Operation */
export function perform<T>(effect: Helpers.Effect<T>): Operation<T> {
  return {
    [Symbol.iterator]() {
      let result: Result<T> | undefined = undefined
      const out: Helpers.Effect<T> = {
        cause: `perform <${effect.cause}>`,
        enter(resolve, routine) {
          return effect.enter(r => {
            resolve((result = r))
          }, routine)
        },
      }

      return {
        next() {
          if (result) {
            if (isSuccess(result)) {
              return { done: true, value: result.value }
            }

            // raise the Failure itself so Result-style catches see the failure object
            throw result
          }

          return { done: false, value: out }
        },
        throw(error) {
          throw error
        },
      }
    },
  }
}
