import type { Result } from 'std:result'
import { fail, succeed } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

export const action = <T>(executor: Helpers.Executor<T>, desc?: string): Operation<T> => ({
  *[Symbol.iterator]() {
    const effect: Helpers.Effect<T> = [
      settle => {
        const resolve = (value: T) => {
          settle(succeed<T>(value) as Result<T, never>)
        }
        const reject = (error: unknown) => {
          settle(fail(error))
        }
        const discard = executor(resolve, reject)
        return discarded => {
          try {
            discard()
            discarded(succeed())
          } catch (error) {
            discarded(fail(error))
          }
        }
      },
      desc ?? 'action',
    ]

    return (yield effect) as T
  },
})
