import type { BlobType, Fn } from '../../shared'

import { forward } from './forward'

/**
 * The capsule function is used to wrap a function for unknown errors
 * This function doesn't return a Result or AsyncResult
 */
export const capsule = <A extends BlobType[], R>(fn: (...args: A) => R, ...additionalCauses: Std.ErrorValues[]) => {
  return ((...args: A) => forward(() => fn(...args), ...additionalCauses)) as Fn<A, R>
}
