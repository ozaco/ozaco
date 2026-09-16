import { appendCauses, asFailure, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

/**
 * Wrap a generator function as a re-entrant `Operation` factory. A RETURNED `Result` is unwrapped:
 * a `Success` yields its value, a `Failure` is raised — so a body may `return yield* attempt(...)`
 * and let the caller see the outcome the std way. A thrown error is folded into a `Failure`
 * carrying `causes`.
 */
export function operation<Args extends AnyType[], T>(
  fn: (...args: Args) => Generator<Helpers.Step, T, unknown>,
  ...causes: string[]
): (...args: Args) => Operation<T> {
  return (...args) => ({
    *[Symbol.iterator](): Generator<Helpers.Step, T, unknown> {
      try {
        const result = yield* fn(...args)

        if (isFailure(result)) {
          return yield* result
        }

        return (isSuccess(result) ? result.value : result) as T
      } catch (error) {
        return yield* appendCauses(asFailure(error), ...causes)
      }
    },
  })
}
