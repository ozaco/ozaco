import type { AnyType, Writable } from 'std:shared'
import { isPromise } from 'std:shared'

import { RESULT_SUCCESS } from '../const'
import type { Impl } from '../types/impl'
import type { Result } from '../types/result'

const UNIT = Object.freeze({
  _t: RESULT_SUCCESS,

  *[Symbol.iterator]() {
    return (this as AnyType).value
  },
}) as unknown as Result.Success<AnyType>

export const succeed: Impl.Succeed = (...args: AnyType[]) => {
  if (args.length === 0) {
    return UNIT as AnyType
  }

  const success = {
    _t: RESULT_SUCCESS,

    *[Symbol.iterator]() {
      return (this as AnyType).value
    },
  } as Writable<Result.Success<AnyType>>

  const value = args[0]

  /**
   * Unwrap only a FOREIGN promise — never an effect-native value.
   *
   * A `Future`/`Task`/`Stream` built by `operation()` is deliberately thenable (await-side interop),
   * so `isPromise` alone cannot tell "an async computation to settle" from "an operation handed
   * around as a value". Calling `.then` on one here RUNS it as a floating task and replaces the
   * value with its settled `Result` — which is how a lane returned by an action reached `attempt`
   * as a Promise and came out as `stream: undefined`. `Symbol.iterator` is the discriminator: a
   * plain promise is not an operation, and an operation used as a value stays one.
   */
  if (isPromise(value) && !(Symbol.iterator in (value as object))) {
    return value.then(resolved => {
      success.value = resolved

      return success
    }) as AnyType
  }

  success.value = value

  return success as AnyType
}
