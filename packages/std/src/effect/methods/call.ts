import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { constant } from '../internal/constant'
import { action } from './action'

export function call<T, TArgs extends unknown[] = []>(
  fn: (...args: TArgs) => Promise<T>,
): Operation<T>
export function call<T, TArgs extends unknown[] = []>(
  fn: (...args: TArgs) => Operation<T>,
): Operation<T>
export function call<T, TArgs extends unknown[] = []>(fn: (...args: TArgs) => T): Operation<T>
export function call<T, TArgs extends unknown[] = []>(
  callable: Helpers.Callable<T, TArgs>,
  ...args: TArgs
): Operation<T> {
  return {
    [Symbol.iterator]() {
      // oxlint-disable-next-line no-useless-call
      let target = callable.call(void 0, ...args)
      if (
        typeof target === 'string' ||
        Array.isArray(target) ||
        target instanceof Map ||
        target instanceof Set
      ) {
        return constant(target)[Symbol.iterator]()
      } else if (isPromise<T>(target)) {
        return action<T>(function wait(resolve, reject) {
          target.then(resolve, reject)
          return () => {}
        }, `async call ${callable.name}()`)[Symbol.iterator]()
      } else if (isOperation<T>(target)) {
        return target[Symbol.iterator]()
      }
      return constant(target)[Symbol.iterator]()
    },
  }
}

const isPromise = <T>(target: Operation<T> | Promise<T> | T): target is Promise<T> =>
  target && typeof (target as Promise<T>).then === 'function'

const isOperation = <T>(target: Operation<T> | Promise<T> | T): target is Operation<T> =>
  target && typeof (target as Operation<T>)[Symbol.iterator] === 'function'
