import type { Result } from 'std:result'
import { asFailure, succeed, unwrap } from 'std:result'
import { isPromise } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'
import { isCallTarget } from '../utils/is'

import { action } from './action'
import { constant } from './constant'
import { lift } from './lift'
import { spawn } from './spawn'
import { encapsulate } from './task-group'
import { withResolvers } from './with-resolvers'

export function call<T, TArgs extends unknown[] = []>(
  fn: (...args: TArgs) => Operation<T>,
  ...args: TArgs
): Operation<T>
export function call<T, TArgs extends unknown[] = []>(
  fn: (...args: TArgs) => Promise<T>,
  ...args: TArgs
): Operation<T>
export function call<T, TArgs extends unknown[] = []>(
  fn: (...args: TArgs) => T,
  ...args: TArgs
): Operation<T>

/**
 * Pause the current operation and evaluate an async function, generator function, or plain
 * function — a uniform integration point. The function is invoked anew every time the operation is
 * evaluated.
 */
export function call<T, TArgs extends unknown[] = []>(
  callable: Helpers.Callable<T | Promise<T> | Operation<T>, TArgs>,
  ...args: TArgs
): Operation<T> {
  return {
    [Symbol.iterator]() {
      const target = callable(...args)
      if (
        typeof target === 'string' ||
        Array.isArray(target) ||
        target instanceof Map ||
        target instanceof Set
      ) {
        return constant(target as T)[Symbol.iterator]()
      } else if (isCallTarget<T>(target)) {
        // iterable thenables (Task/Future) must take their OPERATION side: the std promise side
        // resolves to a Result and never rejects, so the promise branch would swallow failures
        return target[Symbol.iterator]()
      } else if (isPromise(target)) {
        return action<T>((resolve, reject) => {
          ;(target as Promise<T>).then(resolve, reject)
          return () => {}
        }, `async call ${callable.name}()`)[Symbol.iterator]()
      }
      return constant(target as T)[Symbol.iterator]()
    },
  }
}

/**
 * Call with current continuation: run `op` with `resolve`/`reject` operations that jump execution
 * back to this point.
 */
export function* callcc<T>(
  op: (
    resolve: (value: T) => Operation<void>,
    reject: (error: unknown) => Operation<void>,
  ) => Operation<void>,
): Operation<T> {
  const result = withResolvers<Result<T>>('callcc')
  const resolve = lift((value: T) => result.resolve(succeed(value) as Result.Success<T>))
  const reject = lift((error: unknown) => result.resolve(asFailure(error)))

  return yield* encapsulate(function* () {
    yield* spawn(() => op(resolve, reject))

    return unwrap(yield* result.operation)
  })
}
