import { type BlobType, isPromise } from 'std:shared'

import type { Impl } from '../types'

import { isSuccess } from './is'
import { fail } from './result'

export const mapError: Impl.MapError = (fn: BlobType) => {
  return (result: BlobType) => {
    const apply = (r: BlobType) => {
      if (isSuccess(r)) return r

      return fail(fn(r.error), r.message, ...r.causes)
    }

    return (isPromise(result) ? result.then(apply) : apply(result)) as BlobType
  }
}
