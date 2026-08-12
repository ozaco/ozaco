import type { Result } from 'std:result'
import { asFailure, auto } from 'std:result'
import { lazyPromiseWithResolvers } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Future } from '../types/operation'

import { withResolvers } from './with-resolvers'

export function createFuture<T>(): Helpers.FutureWithResolvers<T> {
  const promise = lazyPromiseWithResolvers<Result<T>>()
  const operation = withResolvers<T>()

  const resolve = (rawValue: T) => {
    const value = auto(rawValue) as Result<T>

    promise.resolve(value)
    operation.resolve(rawValue)
  }

  const reject = (rawError: unknown) => {
    const error = asFailure(rawError)

    promise.reject(error)
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
