import { type BlobType, isPromise } from 'std:shared'

import type { Impl } from '../types'
import { isSuccess } from './is'

export const orElse: Impl.OrElse = (fn: BlobType) => {
  return (result: BlobType) => {
    const apply = (r: BlobType) => {
      if (isSuccess(r)) return r

      return fn(r)
    }

    return isPromise(result) ? result.then(apply) : apply(result)
  }
}
