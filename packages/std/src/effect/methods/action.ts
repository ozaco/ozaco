import { fail, succeed, type Result } from 'std:result'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

export const action = <T>(executor: Helpers.Executor<T>, desc?: string): Operation<T> => ({
  *[Symbol.iterator]() {
    let effect: Helpers.Effect<T> = {
      description: desc ?? 'action',
      enter: settle => {
        let resolve = (value: T) => {
          settle(succeed<T>(value) as Result<T, never>)
        }
        let reject = (error: unknown) => {
          settle(fail(error))
        }
        let discard = executor(resolve, reject)
        return discarded => {
          try {
            discard()
            discarded(succeed())
          } catch (error) {
            discarded(fail(error))
          }
        }
      },
    }
    return (yield effect) as T
  },
})
