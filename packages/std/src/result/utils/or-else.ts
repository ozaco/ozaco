import { type BlobType, isPromise } from 'std:shared'

import type { Failure, Helpers, Impl, Result, ResultMaybeAsync } from '../types'
import { isSuccess } from './is'

export const orElse: Impl.OrElse = <
  R1 extends ResultMaybeAsync<BlobType, BlobType>,
  R2 extends ResultMaybeAsync<BlobType, BlobType>,
>(
  fn: (a: Failure<Helpers.InferFailure<R1>>) => R2,
) => {
  return (result: R1) => {
    const apply = (r: Result<Helpers.InferSuccess<R1>, Helpers.InferFailure<R1>>) => {
      if (isSuccess(r)) return r

      return fn(r)
    }

    return isPromise(result) ? result.then(apply) : apply(result)
  }
}
