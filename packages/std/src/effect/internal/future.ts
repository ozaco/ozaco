import { fail, succeed } from 'std:result'
import type { AnyType } from 'std:shared'
import { lazyPromiseWithResolvers } from 'std:shared'

import { withResolvers } from '../methods/with-resolvers'
import type { Helpers } from '../types/helpers'
import type { Future } from '../types/operation'

export const createFuture = <T>(): Helpers.FutureWithResolvers<T> => {
  const promise = lazyPromiseWithResolvers<AnyType>()
  const operation = withResolvers<T>()

  const resolve = (value: T) => {
    promise.resolve(succeed(value))
    operation.resolve(value)
  }

  const reject = (error: unknown) => {
    promise.resolve(fail(error))
    operation.reject(error)
  }

  const future = Object.defineProperties(promise.promise, {
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
