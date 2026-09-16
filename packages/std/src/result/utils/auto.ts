import type { AnyType } from 'std:shared'

import type { ResultDef } from '../types/def'

import { isFailure, isResult } from './is'
import { succeed } from './success'

export const auto: ResultDef.Auto = (...args: AnyType[]): AnyType => {
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
