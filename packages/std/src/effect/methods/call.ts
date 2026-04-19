import { isPromise } from 'std:shared'

import { constant } from '../internal/constant'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { action } from './action'
import { isOperation } from './is'

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
      const target = callable.call(void 0, ...args)
      if (
        typeof target === 'string' ||
        Array.isArray(target) ||
        target instanceof Map ||
        target instanceof Set
      ) {
        return constant(target)[Symbol.iterator]()
      } else if (isPromise(target)) {
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
