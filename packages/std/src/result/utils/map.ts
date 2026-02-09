import { type BlobType, isPromise } from 'std:shared'

import type { Helpers, Impl, Result, ResultFor, ResultFromUnion, ResultMaybeAsync } from '../types'

import { auto } from './auto'
import { isFailure } from './is'

export const map: Impl.Map = <T1, T2>(fn: (a: T1) => T2) => {
  type ResultForGeneric<T> = ResultFor<T2, Helpers.InferSuccess<ResultFromUnion<T2>>, Helpers.InferFailure<T>>

  return <R1 extends ResultMaybeAsync<T1, BlobType>>(result: R1): ResultForGeneric<R1> => {
    const apply = (r: Result<T1, Helpers.InferFailure<R1>>) => {
      if (isFailure(r)) {
        return r
      }

      return auto<T2>(fn(r.value))
    }

    if (isPromise(result)) {
      return result.then<unknown>(apply) as ResultForGeneric<R1>
    }

    return apply(result) as ResultForGeneric<R1>
  }
}
