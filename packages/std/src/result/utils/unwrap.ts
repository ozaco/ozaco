import { isPromise, type AnyType } from 'std:shared'

import { isFailure, isResult } from './is'
import type { Impl } from '../types/impl'

export const unwrap: Impl.Unwrap = ((...args: AnyType[]): AnyType => {
  const firstArgument = args[0]

  if (isResult(firstArgument) || isPromise(firstArgument)) {
    const hasDefault = args.length === 2
    const defaultValue = hasDefault ? args[1] : undefined

    const apply = (r: AnyType) => {
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

  return (result: AnyType) => {
    const apply = (r: AnyType) => {
      if (isFailure(r)) {
        if (hasDefault) return defaultValue

        throw r
      }

      return r.value
    }

    return isPromise(result) ? result.then(apply) : apply(result)
  }
}) as AnyType
