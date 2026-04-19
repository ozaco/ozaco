import { isPromise } from 'std:shared'
import type { AnyType, Writable } from 'std:shared'

import { RESULT_FAILURE } from '../const'
import type { Impl } from '../types/impl'
import type { Failure } from '../types/result'

export const fail: Impl.Fail = (...args: AnyType[]) => {
  const failure = {
    _t: RESULT_FAILURE,

    *[Symbol.iterator]() {
      // oxlint-disable-next-line no-this-alias
      const self = this
      yield self
    },
  } as Writable<Failure<AnyType>>

  if (args.length === 0) {
    failure.causes = [] as string[]
    failure.message = ''

    return failure as AnyType
  }

  const error = args[0]
  const message = args[1] ?? ''
  const causes = args.slice(2)

  failure._d = Date.now()

  if (isPromise(error)) {
    return error.then(resolved => {
      failure.causes = causes
      failure.message = message
      failure.error = resolved

      return failure
    }) as AnyType
  }

  failure.causes = causes
  failure.message = message
  failure.error = error

  return failure as AnyType
}
