import type { Result } from 'std:result'
import { asFailure, succeed } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { perform } from './perform'

/**
 * Create an {@link Operation} that can be resolved (or rejected) with a synchronous callback —
 * the effect equivalent of `new Promise()`. Actions are stateless: the executor runs every time
 * the action is evaluated, and must return a "finally" function that always runs, whether the
 * action was resolved, rejected, or discarded.
 */
export function action<T>(executor: Helpers.Executor<T>, cause?: string): Operation<T> {
  return perform({
    cause: cause ?? 'action',
    enter: settle => {
      const resolve = (value: T) => {
        settle(succeed(value) as Result.Success<T>)
      }
      const reject = (error: unknown) => {
        settle(asFailure(error, cause))
      }
      const discard = executor(resolve, reject)

      return discarded => {
        try {
          discard()
          discarded(succeed())
        } catch (error) {
          discarded(asFailure(error, cause))
        }
      }
    },
  })
}
