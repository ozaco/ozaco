import type { Result } from 'std:result'
import { isSuccess } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

export const Do = <T>(effect: Helpers.Effect<T>): Operation<T> => ({
  [Symbol.iterator]() {
    let result: Result<T, unknown> | undefined = undefined
    let perform: Helpers.Effect<T> = {
      description: `do <${effect.description}>`,
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
            return { done: true as const, value: result.value }
          }
          throw result.error
        }
        return { done: false as const, value: perform }
      },
      throw(error: unknown) {
        throw error
      },
    }
  },
})
