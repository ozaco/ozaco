import { isPromise } from 'std:shared'
import type { AnyType, Writable } from 'std:shared'

import { RESULT_SUCCESS } from '../const'
import type { Impl } from '../types/impl'
import type { Success } from '../types/result'

export const succeed: Impl.Succeed = (...args: AnyType[]) => {
  const success = {
    _t: RESULT_SUCCESS,

    // oxlint-disable-next-line require-yield
    *[Symbol.iterator]() {
      return this.value
    },
  } as Writable<Success<AnyType>>

  if (args.length === 0) {
    return success as AnyType
  }

  const value = args[0]

  if (isPromise(value)) {
    return value.then(resolved => {
      success.value = resolved

      return success
    }) as AnyType
  }

  success.value = value

  return success as AnyType
}
