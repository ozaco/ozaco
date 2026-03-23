import { lazyPromiseWithResolvers } from 'std:shared'

import type { Future } from '../types/operation'
import type { Helpers } from '../types/helpers'

import { withResolvers } from '../methods/with-resolvers'

export const createFuture = <T>(): Helpers.FutureWithResolvers<T> => {
  let promise = lazyPromiseWithResolvers<T>()
  let operation = withResolvers<T>()

  let resolve = (value: T) => {
    promise.resolve(value)
    operation.resolve(value)
  }

  let reject = (error: unknown) => {
    promise.reject(error)
    operation.reject(error)
  }

  let future = Object.defineProperties(promise.promise, {
    [Symbol.iterator]: {
      enumerable: false,
      value: operation.operation[Symbol.iterator],
    },
    [Symbol.toStringTag]: {
      enumerable: false,
      configurable: true,
      value: 'Future',
    },
  }) as unknown as Future<T>

  return { future, resolve, reject }
}
