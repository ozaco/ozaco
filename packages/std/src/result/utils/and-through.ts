import { type BlobType, isPromise } from 'std:shared'

import type { Impl, InferFailure, InferSuccess, Result, ResultMaybeAsync } from '../types'

import { isFailure } from './is'

export const andThrough: Impl.AndThrough = <
  R1 extends ResultMaybeAsync<BlobType, BlobType>,
  R2 extends ResultMaybeAsync<BlobType, BlobType>,
>(
  fn: (a: InferSuccess<R1>) => R2,
) => {
  return (result: R1) => {
    const apply = (r: Result<InferSuccess<R1>, InferFailure<R1>>) => {
      if (isFailure(r)) return r
      const next = fn(r.value)
      if (isPromise(next)) {
        return next.then(n => {
          if (isFailure(n)) return n
          return r
        })
      }

      if (isFailure(next)) return next
      return r
    }

    return isPromise(result) ? result.then(apply) : apply(result)
  }
}
