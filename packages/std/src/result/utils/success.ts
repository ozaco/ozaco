import type { AnyType, Writable } from 'std:shared'

import { RESULT_SUCCESS } from '../const'
import type { ResultDef } from '../types/def'
import type { Result } from '../types/result'

// `value` is present (undefined) — the object is shaped exactly as `Result.Success<void>` says
const UNIT = Object.freeze({
  _t: RESULT_SUCCESS,
  value: undefined,

  *[Symbol.iterator]() {
    return void 0
  },
}) as unknown as Result.Success<AnyType>

export const succeed: ResultDef.Succeed = (...args: AnyType[]) => {
  if (args.length === 0) {
    return UNIT as AnyType
  }

  return {
    _t: RESULT_SUCCESS,
    value: args[0],

    *[Symbol.iterator]() {
      return (this as AnyType).value
    },
  } as Writable<Result.Success<AnyType>>
}
