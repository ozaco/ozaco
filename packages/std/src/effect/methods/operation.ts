import type { Failure, Result } from 'std:result'
import { appendCauses, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Future } from '../types/operation'

import { run } from './run'

export const operation =
  <Args extends AnyType[], T, E = never>(
    fn: (...args: Args) => Generator<Failure<E> | Helpers.Effect<unknown>, T, unknown>,
    ...causes: string[]
  ): ((...args: Args) => Future<T, E>) =>
  (...args) => {
    const op = {
      [Symbol.iterator](): Iterator<Helpers.Effect<unknown>, T, unknown> {
        const inner = fn(...args)
        return {
          next(value: unknown) {
            const step = inner.next(value)
            if (step.done) {
              return { done: true, value: step.value }
            }
            if (isFailure(step.value as AnyType)) {
              throw appendCauses(step.value as Failure<E>, ...causes)
            }
            return { done: false, value: step.value as Helpers.Effect<unknown> }
          },
          throw(error: unknown) {
            const step = inner.throw?.(error)
            if (!step || step.done) {
              throw error
            }
            if (isFailure(step.value as AnyType)) {
              throw appendCauses(step.value as Failure<E>, ...causes)
            }
            return { done: false, value: step.value as Helpers.Effect<unknown> }
          },
          return(value: unknown) {
            inner.return?.(value as AnyType)
            return { done: true, value: value as AnyType }
          },
        }
      },
    } as Future<T, E>

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
