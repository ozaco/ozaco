import type { AnyType } from 'std:shared'

import type { Impl } from '../types/impl'

import { isFailure, isResult } from './is'
import { succeed } from './success'

export const auto: Impl.Auto = (...args: AnyType[]): AnyType => {
  const firstArgument = args[0]
  const hasDefaultValue = args.length === 2
  const defaultValue = hasDefaultValue ? args[1] : undefined

  if (isResult(firstArgument)) {
    if (isFailure(firstArgument) && hasDefaultValue) {
      return auto(defaultValue)
    }

    return firstArgument
  }

  return succeed(firstArgument)
}
