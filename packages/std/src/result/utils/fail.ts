import type { AnyType, Writable } from 'std:shared'

import { RESULT_FAILURE } from '../const'
import type { Impl } from '../types/impl'
import type { Result } from '../types/result'

export const fail: Impl.Fail = (...args: AnyType[]) => {
  const failure = {
    _t: RESULT_FAILURE,
    _d: Date.now(),

    *[Symbol.iterator]() {
      // oxlint-disable-next-line no-this-alias
      const self = this
      yield self
    },
  } as Writable<Result.Failure<AnyType>>

  if (args.length === 0) {
    failure.causes = [] as string[]
    failure.message = ''

    return failure as AnyType
  }

  failure.error = args[0]
  failure.message = args[1] ?? ''
  failure.causes = args.slice(2)

  return failure as AnyType
}
