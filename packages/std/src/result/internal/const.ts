import type { AnyType } from 'std:shared'

import { RESULT_SUCCESS } from '../const'
import type { Result } from '../types/result'

/** The value of a bare `succeed()`: `value` is present (undefined) — the object is shaped exactly
 * as `Result.Success<void>` says. */
export const UNIT = Object.freeze({
  _t: RESULT_SUCCESS,
  value: undefined,

  *[Symbol.iterator]() {
    return void 0
  },
}) as unknown as Result.Success<AnyType>
