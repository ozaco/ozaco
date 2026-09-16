import { isPromise } from 'std:shared'
import type { AnyType } from 'std:shared'

import type { ResultDef } from '../types/def'
import type { Result } from '../types/result'

import { auto } from './auto'
import { fail } from './fail'

export const throwable: ResultDef.Throwable = ((
  cb: () => AnyType,
  errorClass?: Result.ErrorConstructor,
  ...causes: string[]
): AnyType => {
  const CustomError = errorClass ?? Error

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
}) as ResultDef.Throwable
