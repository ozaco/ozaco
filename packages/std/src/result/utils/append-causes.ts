import type { AnyType } from 'std:shared'
import { isPromise, isString } from 'std:shared'

import type { Impl } from '../types/impl'

import { isFailure } from './is'

export const appendCauses: Impl.AppendCauses = (firstArgument, ...causes): AnyType => {
  if (!isString(firstArgument) && firstArgument) {
    const apply = (result: AnyType) => {
      if (isFailure(result)) {
        result.causes.push(...causes)
      }

      return result
    }

    return isPromise(firstArgument) ? firstArgument.then(apply) : apply(firstArgument)
  }

  if (!firstArgument) {
    return (result: AnyType) => result
  }

  const apply = (failure: AnyType) => {
    if (isFailure(failure)) {
      failure.causes.push(firstArgument, ...causes)
    }

    return failure
  }

  return (result: AnyType) => (isPromise(result) ? result.then(apply) : apply(result))
}
