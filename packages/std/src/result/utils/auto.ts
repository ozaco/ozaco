import { type BlobType, isPromise } from 'std:shared'

import type { Impl } from '../types'

import { isFailure, isResult } from './is'
import { succeed } from './result'

export const auto: Impl.Auto = (...args: BlobType[]): BlobType => {
  const firstArgument = args[0]
  const hasDefaultValue = args.length === 2
  const defaultValue = hasDefaultValue ? args[1] : undefined

  if (isPromise(firstArgument)) {
    return firstArgument.then(newResponse => auto(newResponse, defaultValue))
  } else if (isResult(firstArgument)) {
    if (isFailure(firstArgument) && hasDefaultValue) {
      return auto(defaultValue)
    }

    return firstArgument
  }

  return succeed(firstArgument)
}
