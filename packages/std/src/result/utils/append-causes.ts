import { type BlobType, isPromise, isString } from 'std:shared'

import type { Impl, Result, ResultMaybeAsync } from '../types'

import { isFailure, isResult } from './is'

export const appendCauses: Impl.AppendCauses = (
  firstArgument: ResultMaybeAsync<unknown, unknown> | string | undefined,
  ...causes: string[]
): BlobType => {
  if (!isString(firstArgument) && firstArgument) {
    const apply = (result: Result<unknown, unknown>) => {
      if (isResult(result) && isFailure(result)) {
        result.causes.push(...causes)
      }

      return result
    }

    return isPromise(firstArgument) ? firstArgument.then(apply) : apply(firstArgument)
  }

  if (!firstArgument) {
    return (result: ResultMaybeAsync<unknown, unknown>) => result
  }

  const apply = (failure: Result<unknown, unknown>) => {
    if (isResult(failure) && isFailure(failure)) {
      failure.causes.push(firstArgument, ...causes)
    }

    return failure
  }

  return (result: ResultMaybeAsync<unknown, unknown>) => (isPromise(result) ? result.then(apply) : apply(result))
}
