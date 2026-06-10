import type { Result } from 'std:result'
import { appendCauses, asFailure, isFailure, isSuccess } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Future } from '../types/operation'

import { run } from './run'

export function operation<Args extends AnyType[], T, E = never>(
  fn: (...args: Args) => Generator<Helpers.Effect<unknown> | Helpers.FailureOf<E>, T, unknown>,
  ...causes: string[]
): (...args: Args) => Future<T, E> {
  return (...args) => {
    const op = {
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
    } as unknown as Future<T, E>

    const settled = () => run(() => op) as Promise<Result<T, E>>

    // yield* uses [Symbol.iterator] → runs through effect
    // await uses .then() → settles into Result<T, E>
    return Object.defineProperties(op, {
      // oxlint-disable-next-line unicorn/no-thenable
      then: {
        enumerable: false,
        value: (...$args: AnyType[]) => settled().then(...$args),
      },
      catch: {
        enumerable: false,
        value: (...$args: AnyType[]) => settled().catch(...$args),
      },
      finally: {
        enumerable: false,
        value: (...$args: AnyType[]) => settled().finally(...$args),
      },
    })
  }
}
