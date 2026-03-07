import { type BlobType, isPromise } from 'std:shared'

import type { Impl } from '../types'

import { isFailure, isResult } from './is'

export const unwrap: Impl.Unwrap = (...args: BlobType[]): BlobType => {
  const firstArgument = args[0]

  if (isResult(firstArgument) || isPromise(firstArgument)) {
    const hasDefault = args.length === 2
    const defaultValue = hasDefault ? args[1] : undefined

    const apply = (r: BlobType) => {
      if (isFailure(r)) {
        if (hasDefault) return defaultValue

        throw r
      }

      return r.value
    }

    return isPromise(firstArgument) ? firstArgument.then(apply) : apply(firstArgument)
  }

  const hasDefault = args.length === 1
  const defaultValue = hasDefault ? args[0] : undefined

  return (result: BlobType) => {
    const apply = (r: BlobType) => {
      if (isFailure(r)) {
        if (hasDefault) return defaultValue

        throw r
      }

      return r.value
    }

    return isPromise(result) ? result.then(apply) : apply(result)
  }
}
