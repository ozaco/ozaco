import { type BlobType, isPromise, type Writable } from 'std:shared'

import { RESULT_FAILURE, RESULT_SUCCESS } from '../const'
import type { Failure, Impl, Success } from '../types'

export const fail: Impl.Fail = (...args: BlobType[]) => {
  const failure = {
    _t: RESULT_FAILURE,
    _d: Date.now(),

    *[Symbol.iterator]() {
      // biome-ignore lint/complexity/noUselessThisAlias: Redundant
      const self = this
      yield self
      return self
    },
  } as Writable<Failure<BlobType>>

  if (args.length === 0) {
    failure.causes = [] as string[]
    failure.message = ''

    return failure as BlobType
  }

  const error = args[0]
  const message = args[1] ?? ''
  const causes = args.slice(2)

  if (isPromise(error)) {
    return error.then(error => {
      failure.causes = causes
      failure.message = message
      failure.error = error

      return failure
    }) as BlobType
  }

  failure.causes = causes
  failure.message = message
  failure.error = error

  return failure as BlobType
}

export const succeed: Impl.Succeed = (...args: BlobType[]) => {
  const success = {
    _t: RESULT_SUCCESS,

    // biome-ignore lint/correctness/useYield: Redundant
    *[Symbol.iterator]() {
      return this.value
    },
  } as Writable<Success<BlobType>>

  if (args.length === 0) {
    return success as BlobType
  }

  const value = args[0]
  if (isPromise(value)) {
    return value.then(value => {
      success.value = value

      return success
    }) as BlobType
  }

  success.value = value

  return success as BlobType
}
