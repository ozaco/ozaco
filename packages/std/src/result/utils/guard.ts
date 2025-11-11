import { type BlobType, isString } from 'std:shared'

import type { Impl } from '../types'

import { auto } from './auto'
import { isFailure, isResult } from './is'
import { mapError } from './map-error'
import { pipe } from './pipe'

export const guard: Impl.Guard = (...args: BlobType[]): BlobType => {
  const firstArgument = args[0]

  if (isString(firstArgument)) {
    return (result: BlobType) => guard(result, ...args)
  }

  const causes = args.slice(1)

  return (...args: BlobType[]) =>
    pipe(
      firstArgument.apply(null, args),
      auto(),
      mapError(error => {
        if (isResult(error) && isFailure(error)) {
          error.causes.push(...causes)
        }

        return error
      }),
    )
}
