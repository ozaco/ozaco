import { type BlobType, isPromise } from 'std:shared'

import type { Impl, InferFailure, InferSuccess, Result, ResultMaybeAsync } from '../types'
import { isSuccess } from './is'

export const orElse: Impl.OrElse = <
  R1 extends ResultMaybeAsync<BlobType, BlobType>,
  R2 extends ResultMaybeAsync<BlobType, BlobType>,
>(
  fn: (a: InferFailure<R1>) => R2,
) => {
  return (result: R1) => {
    const apply = (r: Result<InferSuccess<R1>, InferFailure<R1>>) => {
      if (isSuccess(r)) return r
      return fn(r.error)
    }

    return isPromise(result) ? result.then(apply) : apply(result)
  }
}
