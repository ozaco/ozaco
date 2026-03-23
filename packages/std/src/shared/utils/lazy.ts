import type { Result } from 'std:result'
import { fail, isSuccess, succeed } from 'std:result'
import type { PromiseWithResolvers } from 'std:shared'

export const lazyPromise = <T, E>(
  resolver: (resolve: (value: T) => void, reject: (error: E) => void) => void,
): Promise<T> => {
  let _promise: Promise<T> | undefined = undefined

  // oxlint-disable-next-line oxc/no-async-await
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
  const reject = (error: unknown) => settle(fail(error))

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
