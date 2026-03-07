import { isPromise, type AnyType } from 'std:shared'

import type { Impl } from '../types/impl'
import { fail } from './fail'
import { auto } from './auto'

export const throwable: Impl.Throwable = (cb, rawCustomError, ...causes) => {
  const CustomError = rawCustomError ?? Error

  try {
    const result = cb()

    if (isPromise(result)) {
      return result.then(auto as AnyType, (err: AnyType) => {
        if (err instanceof CustomError) return fail(err, 'from throwable', ...causes)

        return fail(new CustomError(err as AnyType), 'from throwable', ...causes)
      })
    }

    return auto(result)
  } catch (rawErr) {
    const err = rawErr as AnyType

    if (err instanceof CustomError) return fail(err, 'from throwable', ...causes) as AnyType

    return fail(new CustomError(err as AnyType), 'from throwable', ...causes) as AnyType
  }
}
