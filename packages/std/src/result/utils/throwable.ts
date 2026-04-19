import { isPromise } from 'std:shared'
import type { AnyType } from 'std:shared'

import type { Impl } from '../types/impl'

import { auto } from './auto'
import { fail } from './fail'

export const throwable: Impl.Throwable = (cb, rawCustomError, ...causes) => {
  const CustomError = rawCustomError ?? Error

  try {
    const result = cb()

    if (isPromise(result)) {
      return result.then(auto as AnyType, (error: AnyType) => {
        if (error instanceof CustomError) {
          return fail(error, 'from throwable', ...causes)
        }

        return fail(new CustomError(error as AnyType), 'from throwable', ...causes)
      })
    }

    return auto(result)
  } catch (error) {
    if (error instanceof CustomError) {
      return fail(error, 'from throwable', ...causes) as AnyType
    }

    return fail(new CustomError(error as AnyType), 'from throwable', ...causes) as AnyType
  }
}
