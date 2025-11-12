import { type BlobType, isAsyncGenerator, isGenerator, isPromise, isString } from 'std:shared'

import type { Impl } from '../types'

import { auto } from './auto'
import { isFailure, isResult } from './is'
import { pipe } from './pipe'

export const guard: Impl.Guard = (...args: BlobType[]): BlobType => {
  const firstArgument = args[0]

  if (isString(firstArgument)) {
    return (result: BlobType) => guard(result, ...args)
  }

  const causes = args.slice(1)

  return (...args: BlobType[]) =>
    pipe(
      firstArgument(...args),
      rawResult => {
        let result = rawResult

        if (isGenerator(rawResult)) {
          result = rawResult.next().value
        } else if (isAsyncGenerator(rawResult)) {
          result = rawResult.next().then((result: BlobType) => result.value)
        }

        if (isResult(result) && isFailure(result)) {
          result.causes.push(...causes)
        } else if (isPromise(result)) {
          return result.then(result => {
            if (isResult(result) && isFailure(result)) {
              result.causes.push(...causes)
            }
            return result
          })
        }

        return result
      },
      auto(),
    )
}
