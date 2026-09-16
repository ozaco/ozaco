import type { AnyType } from 'std:shared'

import { RESULT_FAILURE } from '../const'
import type { ResultDef } from '../types/def'
import type { Result } from '../types/result'

// every field the type declares is present, `error` included (undefined for the bare `fail()`)
export const fail: ResultDef.Fail = (...args: AnyType[]) =>
  ({
    _t: RESULT_FAILURE,
    _d: Date.now(),
    error: args[0],
    message: args[1] ?? '',
    causes: args.slice(2),

    *[Symbol.iterator]() {
      // oxlint-disable-next-line no-this-alias
      const self = this
      yield self
    },
  }) as Result.Failure<AnyType> as AnyType
