import { type BlobType, isPromise } from 'std:shared'

import type { Impl } from '../types'

import { auto } from './auto'
import { isFailure } from './is'

export const map: Impl.Map = (fn: BlobType) => {
  return (result: BlobType) => {
    const apply = (r: BlobType) => {
      if (isFailure(r)) return r

      return auto(fn(r.value))
    }

    return isPromise(result) ? result.then(apply) : (apply(result) as BlobType)
  }
}
