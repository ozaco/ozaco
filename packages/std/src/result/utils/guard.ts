import { type BlobType, isPromise } from 'std:shared'

import type { Impl } from '../types'
import { auto } from './auto'
import { isFailure, isResult } from './is'

export const guard: Impl.Guard = (fn: (...args: BlobType[]) => BlobType, ...causes: string[]): BlobType => {
  return (...args: BlobType[]) => {
    const result = fn(...args)

    if (isPromise(result)) {
      return result.then(result => {
        if (isResult(result)) {
          if (isFailure(result)) {
            result.causes.push(...causes)
          }

          return result
        }

        return auto(result)
      })
    }

    if (isResult(result)) {
      if (isFailure(result)) {
        result.causes.push(...causes)
      }

      return result
    }

    return auto(result)
  }
}
