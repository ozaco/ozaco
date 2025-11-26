import { type BlobType, isPromise } from 'std:shared'

import type { Helpers, Impl, Result, ResultFor, ResultMaybeAsync } from '../types'

import { auto } from './auto'
import { isFailure } from './is'

export const map: Impl.Map = <T1, T2>(fn: (a: T1) => T2) => {
  return <R1 extends ResultMaybeAsync<T1, BlobType>>(result: R1): ResultFor<R1, T2, Helpers.InferFailure<R1>> => {
    const apply = (r: Result<T1, Helpers.InferFailure<R1>>) => {
      if (isFailure(r)) {
        return r
      }

      return auto<T2>(fn(r.value))
    }

    if (isPromise(result)) {
      return result.then<unknown>(apply) as ResultFor<R1, T2, Helpers.InferFailure<R1>>
    }

    return apply(result) as ResultFor<R1, T2, Helpers.InferFailure<R1>>
  }
}
