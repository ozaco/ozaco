import type { Result } from 'std:result'
import { fail, isSuccess, succeed } from 'std:result'
import { type PromiseWithResolvers } from 'std:shared'

export const lazyPromise = <T, E>(
  resolver: (resolve: (value: T) => void, reject: (error: E) => void) => void,
): Promise<T> => {
  let _promise: Promise<T> | undefined = undefined

  let reify = async () => {
    if (!_promise) {
      _promise = new Promise<T>(resolver)
    }
    return await _promise
  }

  let promise: Promise<T> = Object.create(Promise.prototype, {
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

  let resolve = ((value: T) =>
    settle(succeed(value) as Result<T, never>)) as PromiseWithResolvers<T>['resolve']
  let reject = (error: unknown) => settle(fail(error))

  let promise = lazyPromise<T, unknown>(($resolve, $reject) => {
    let record = ($result: Result<T, unknown>) => {
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
