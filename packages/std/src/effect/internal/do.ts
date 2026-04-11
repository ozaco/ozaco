import type { Result } from 'std:result'
import { isSuccess } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

export const doOp = <T>(effect: Helpers.Effect<T>): Operation<T> => ({
  [Symbol.iterator]() {
    let result: Result<T, unknown> | undefined = undefined
    const perform: Helpers.Effect<T> = [
      (resolve, routine) =>
        effect[0](r => {
          resolve((result = r))
        }, routine),
      `do <${effect[1]}>`,
    ]

    return {
      next() {
        if (result) {
          if (isSuccess(result)) {
            return { done: true as const, value: result.value }
          }
          throw result
        }
        return { done: false as const, value: perform }
      },
      throw(error: unknown) {
        throw error
      },
    }
  },
})
