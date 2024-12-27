import type { BlobType } from '../../shared'

import { forward } from './forward'

/**
 * The capsule function is used to wrap a function for unknown errors
 * This function doesn't return a Result or AsyncResult
 */
export const capsule = <A extends BlobType[], R>(
  fn: (...args: A) => R,
  ...additionalCauses: Std.ErrorValues[]
): Std.Middleware<A, R> => {
  const result = ((...args: A) =>
    forward(() => fn(...args), ...additionalCauses)) as Std.Middleware<A, R>

  result.addCauses = (...newAdditionalCauses) => {
    return capsule(fn, ...additionalCauses, ...newAdditionalCauses) as BlobType
  }

  return result
}
