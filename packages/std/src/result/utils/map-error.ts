import { type BlobType, isPromise } from 'std:shared'

import type { Impl, InferSuccess, Result, ResultFor, ResultMaybeAsync } from '../types'

import { isSuccess } from './is'

export const mapError: Impl.MapError = <E1, E2>(fn: (a: E1) => E2) => {
  return <R1 extends ResultMaybeAsync<BlobType, E1>>(result: R1): ResultFor<R1, InferSuccess<R1>, E2> => {
    const apply = (r: Result<InferSuccess<R1>, BlobType>) => {
      if (isSuccess(r)) return r

      return fn(r as E1)
    }

    if (isPromise(result)) {
      return result.then<unknown>(apply) as ResultFor<R1, InferSuccess<R1>, E2>
    }

    return apply(result) as ResultFor<R1, InferSuccess<R1>, E2>
  }
}
