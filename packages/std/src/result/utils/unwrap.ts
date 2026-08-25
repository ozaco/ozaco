import type { AnyType } from 'std:shared'
import { isPromise } from 'std:shared'

import type { Impl } from '../types/impl'

import { isFailure, isResult } from './is'

export const unwrap: Impl.Unwrap = ((...args: AnyType[]): AnyType => {
  const firstArgument = args[0]
  const hasDefault = args.length === 2
  const defaultValue = hasDefault ? args[1] : undefined

  const apply = (r: AnyType) => {
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

  if (isResult(firstArgument)) {
    return apply(firstArgument)
  }

  return firstArgument
}) as AnyType
