import { type BlobType, isPromise, isString } from 'std:shared'

import type { Impl } from '../types'

import { isFailure, isResult } from './is'

export const appendCauses: Impl.AppendCauses = (firstArgument, ...causes: string[]): BlobType => {
  if (!isString(firstArgument) && firstArgument) {
    const apply = (result: BlobType) => {
      if (isResult(result) && isFailure(result)) {
        result.causes.push(...causes)
      }

      return result
    }

    return isPromise(firstArgument) ? firstArgument.then(apply) : apply(firstArgument)
  }

  if (!firstArgument) {
    return (result: BlobType) => result
  }

  const apply = (failure: BlobType) => {
    if (isResult(failure) && isFailure(failure)) {
      failure.causes.push(firstArgument, ...causes)
    }

    return failure
  }

  return (result: BlobType) => (isPromise(result) ? result.then(apply) : apply(result))
}
