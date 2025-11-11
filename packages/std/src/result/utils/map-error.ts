import { type BlobType, isPromise } from 'std:shared'

import type { Impl, InferSuccess, Result, ResultFor, ResultMaybeAsync } from '../types'

import { isSuccess } from './is'
import { fail } from './result'

export const mapError: Impl.MapError = <E1, E2>(fn: (a: E1) => E2) => {
  return <R1 extends ResultMaybeAsync<BlobType, E1>>(result: R1): ResultFor<R1, InferSuccess<R1>, E2> => {
    const apply = (r: Result<InferSuccess<R1>, E1>) => {
      if (isSuccess(r)) return r
      return fail<E2>(fn(r.error))
    }

    if (isPromise(result)) {
      return result.then<unknown>(apply) as ResultFor<R1, InferSuccess<R1>, E2>
    }

    return apply(result) as ResultFor<R1, InferSuccess<R1>, E2>
  }
}
