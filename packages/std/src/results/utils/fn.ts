import type { BlobType } from '../../shared'

import { resultTags } from '../tag'
import { handleCatch, handleThen } from './internal/handlers'

const invalidUsage = resultTags.get('invalid-usage')

/**
 * The $fn function is used to wrap a function that returns a Result or ResultAsync
 * and automatically handles the error cases.
 */
export const $fn = <A extends BlobType[], R, C extends Std.ErrorValues[] = []>(
  fn: (...args: A) => R,
  ...additionalCauses: C
) => {
  const result = ((...args: A) => {
    try {
      const result = fn(...args)

      return handleThen(result, ...additionalCauses)
    } catch (rawError) {
      return handleCatch(rawError, ...additionalCauses)
    }
  }) as Std.Middleware<A, Std.InjectError<Std.UnionsToResult<R>, typeof invalidUsage, C>>

  result.addCauses = (...newAdditionalCauses) => {
    return $fn(fn, ...additionalCauses, ...newAdditionalCauses) as BlobType
  }

  return result
}
