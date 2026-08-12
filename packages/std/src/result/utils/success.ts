import type { AnyType, Writable } from 'std:shared'

import { RESULT_SUCCESS } from '../const'
import type { Impl } from '../types/impl'
import type { Result } from '../types/result'

const UNIT = Object.freeze({
  _t: RESULT_SUCCESS,

  *[Symbol.iterator]() {
    return void 0
  },
}) as unknown as Result.Success<AnyType>

export const succeed: Impl.Succeed = (...args: AnyType[]) => {
  if (args.length === 0) {
    return UNIT as AnyType
  }

  const success = {
    _t: RESULT_SUCCESS,
    value: args[0],

    *[Symbol.iterator]() {
      return (this as AnyType).value
    },
  } as Writable<Result.Success<AnyType>>

  return success as AnyType
}
