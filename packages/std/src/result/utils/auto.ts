import { isPromise, type AnyType } from 'std:shared'

import type { Impl } from '../types/impl'
import { succeed } from './success'
import { isFailure, isResult } from './is'

export const auto: Impl.Auto = (...args: AnyType[]): AnyType => {
  if (args.length === 0) {
    return auto
  }

  const firstArgument = args[0]
  const hasDefaultValue = args.length === 2
  const defaultValue = hasDefaultValue ? args[1] : undefined

  if (isPromise(firstArgument)) {
    return firstArgument.then(newResponse => {
      if (isFailure(newResponse) && hasDefaultValue) {
        return auto(defaultValue)
      }

      return auto(newResponse)
    })
  } else if (isResult(firstArgument)) {
    if (isFailure(firstArgument) && hasDefaultValue) {
      return auto(defaultValue)
    }

    return firstArgument
  }

  return succeed(firstArgument)
}
