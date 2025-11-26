import { type BlobType, isPromise } from 'std:shared'

import type { Helpers, Impl, Result, ResultMaybeAsync } from '../types'

import { isFailure, isResult } from './is'

export const unwrap: Impl.Unwrap = <R extends ResultMaybeAsync<BlobType, BlobType>, T = never>(
  ...args: BlobType[]
): BlobType => {
  const firstArgument = args[0]

  if (isResult<Helpers.InferSuccess<R>, Helpers.InferFailure<R>>(firstArgument) || isPromise(firstArgument)) {
    const result = firstArgument
    const hasDefault = args.length === 2
    const defaultValue = hasDefault ? (args[1] as T) : undefined

    const apply = (r: Result<Helpers.InferSuccess<R>, Helpers.InferFailure<R>>): Helpers.InferSuccess<R> | T => {
      if (isFailure(r)) {
        if (hasDefault) return defaultValue as T

        throw r
      }

      return r.value
    }

    return isPromise(result) ? result.then(apply) : apply(result)
  }

  const hasDefault = args.length === 1
  const defaultValue = hasDefault ? (args[0] as T) : undefined

  return (result: R) => {
    const apply = (r: Result<Helpers.InferSuccess<R>, Helpers.InferFailure<R>>): Helpers.InferSuccess<R> | T => {
      if (isFailure(r)) {
        if (hasDefault) return defaultValue as T

        throw r
      }

      return r.value
    }

    return isPromise(result) ? result.then(apply) : apply(result)
  }
}
