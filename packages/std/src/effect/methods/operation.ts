import type { Failure, Result } from 'std:result'
import { appendCauses, asFailure, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Future } from '../types/operation'

import { run } from './run'

export function operation<Args extends AnyType[], T, E = never>(
  fn: (...args: Args) => Generator<Helpers.Effect<unknown> | Helpers.FailureOf<E>, T, unknown>,
  ...causes: string[]
): (...args: Args) => Future<T, E> {
  return (...args) => {
    const desc = causes.join(',') || 'operation'

    const op = {
      [Symbol.iterator](): Iterator<Helpers.Effect<unknown>, T, unknown> {
        const inner = fn(...args) as Generator<
          Helpers.Effect<unknown> | Helpers.FailureOf<E>,
          T,
          unknown
        >

        return {
          next(value: unknown) {
            let step: IteratorResult<Helpers.Effect<unknown> | Failure<E>, T>

            try {
              step = inner.next(value)
            } catch (error) {
              step = { done: false, value: asFailure(error) as AnyType }
            }

            if (step.done) {
              return { done: true, value: step.value }
            }
            if (isFailure(step.value as AnyType)) {
              throw appendCauses(step.value as Failure<E>, ...causes)
            }
            const effect = step.value as Helpers.Effect<unknown>
            return {
              done: false,
              value: {
                enter: effect.enter,
                cause: `${desc} > ${effect.cause}`,
              },
            }
          },
          throw(error: unknown) {
            let step: IteratorResult<Helpers.Effect<unknown> | Failure<E>, T>

            try {
              step = inner.throw?.(error)
            } catch (subError) {
              step = {
                done: false,
                value: asFailure(subError) as AnyType,
              }
            }

            if (!step || step.done) {
              throw error
            }
            if (isFailure(step.value as AnyType)) {
              throw appendCauses(step.value as Failure<E>, ...causes)
            }
            const effect = step.value as Helpers.Effect<unknown>
            return {
              done: false,
              value: {
                enter: effect.enter,
                cause: `${desc} > ${effect.cause}`,
              },
            }
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
}
