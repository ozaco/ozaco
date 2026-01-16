import { type BlobType, isPromise } from 'std:shared'

import type { Impl } from '../types'
import { auto } from './auto'
import { fail } from './result'

export const throwable: Impl.Throwable = (cb, rawCustomError) => {
  const CustomError = rawCustomError ?? Error

  try {
    const result = cb()

    if (isPromise(result)) {
      return result.then(auto as BlobType, (err: BlobType) => {
        if (err instanceof CustomError) return fail(err, 'from throwable')

        return fail(new CustomError(err as BlobType), 'from throwable')
      })
    }

    return auto(result)
  } catch (rawErr) {
    const err = rawErr as BlobType

    if (err instanceof CustomError) return fail(err, 'from throwable') as BlobType

    return fail(new CustomError(err as BlobType), 'from throwable') as BlobType
  }
}
