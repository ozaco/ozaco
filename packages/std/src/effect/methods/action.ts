import type { Result } from 'std:result'
import { asFailure, auto, succeed } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

export const action = <T>(executor: Helpers.Executor<T>, desc?: string): Operation<T> => ({
  *[Symbol.iterator]() {
    const effect: Helpers.Effect<T> = [
      settle => {
        const resolve = (value: T) => {
          settle(auto(value) as Result<T, never>)
        }
        const reject = (error: unknown) => {
          settle(asFailure(error))
        }
        const discard = executor(resolve, reject)
        return discarded => {
          try {
            discard()
            discarded(succeed())
          } catch (error) {
            discarded(asFailure(error))
          }
        }
      },
      desc ?? 'action',
    ]

    return (yield effect) as T
  },
})
