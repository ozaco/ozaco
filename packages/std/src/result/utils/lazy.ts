import type { PromiseWithResolvers } from 'std:shared'

import type { Result } from '../types/result'

import { fail } from './fail'
import { isFailure, isSuccess } from './is'
import { succeed } from './success'

export const lazyPromise = <T, E>(
  resolver: (resolve: (value: T) => void, reject: (error: E) => void) => void,
): Promise<T> => {
  let _promise: Promise<T> | undefined = undefined

  const reify = async () => {
    if (!_promise) {
      _promise = new Promise<T>(resolver)
    }

    return await _promise
  }

  const promise: Promise<T> = Object.create(Promise.prototype, {
    // oxlint-disable-next-line unicorn/no-thenable
    then: {
      enumerable: false,
      value: (...args: Parameters<Promise<T>['then']>) => reify().then(...args),
    },
    catch: {
      enumerable: false,
      value: (...args: Parameters<Promise<T>['catch']>) => reify().catch(...args),
    },
    finally: {
      enumerable: false,
      value: (...args: Parameters<Promise<T>['finally']>) => reify().finally(...args),
    },
  })

  return promise
}

export const lazyPromiseWithResolvers = <T>(): PromiseWithResolvers<T> => {
  let result: Result<T, unknown> | undefined = undefined

  let settle = (outcome: Result<T, unknown>) => {
    if (!result) {
      result = outcome
    }
  }

  const resolve = ((value: T) =>
    settle(succeed(value) as Result<T, never>)) as PromiseWithResolvers<T>['resolve']
  // the raw rejection rides in the error slot (a Failure as is): the promise rejects with it
  const reject = (error: unknown) => settle(isFailure(error) ? error : fail(error))

  const promise = lazyPromise<T, unknown>(($resolve, $reject) => {
    const record = ($result: Result<T, unknown>) => {
      if (isSuccess($result)) {
        $resolve($result.value)
      } else {
        $reject($result.error)
      }
    }

    if (result) {
      record(result)
    } else {
      settle = record
    }
  })

  return { promise, resolve, reject }
}
