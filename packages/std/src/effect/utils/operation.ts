import type { Result } from 'std:result'
import { appendCauses, asFailure, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

export function operation<Args extends AnyType[], T>(
  fn: (...args: Args) => Generator<Helpers.Effect<unknown> | Result.Failure<AnyType>, T, unknown>,
  ...causes: string[]
): (...args: Args) => Operation<T> {
  return (...args) =>
    ({
      *[Symbol.iterator]() {
        try {
          const result = yield* fn(...args)

          if (isFailure(result)) {
            return yield* result
          }

          return isSuccess(result) ? result.value : result
        } catch (error) {
          yield* appendCauses(asFailure(error), ...causes)
        }
      },
    }) as Operation<T>
}
