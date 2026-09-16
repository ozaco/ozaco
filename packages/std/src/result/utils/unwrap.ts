import type { AnyType } from 'std:shared'
import { isPromise } from 'std:shared'

import type { ResultDef } from '../types/def'

import { isFailure, isResult } from './is'

export const unwrap: ResultDef.Unwrap = ((...args: AnyType[]): AnyType => {
  const firstArgument = args[0]
  const hasDefault = args.length === 2
  const defaultValue = hasDefault ? args[1] : undefined

  // a non-Result passes through unchanged — on the sync path AND behind a promise
  const apply = (r: AnyType) => {
    if (!isResult(r)) {
      return r
    }

    if (isFailure(r)) {
      if (hasDefault) {
        return defaultValue
      }

      throw r
    }

    return r.value
  }

  if (isPromise(firstArgument)) {
    return firstArgument.then(apply)
  }

  return apply(firstArgument)
}) as AnyType
