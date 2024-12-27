import type { BlobType } from '../../shared'

import { ResultAsync } from './async'

import { handleCatch, handleThen } from './internal/handlers'

export const forward = <R, T = Std.InferOkType<Std.UnionsToResult<R>>>(
  fn: () => R,
  ...additionalCauses: Std.ErrorValues[]
): R extends PromiseLike<BlobType> ? Promise<T> : T => {
  try {
    const result = handleThen(fn(), ...additionalCauses)

    if (result instanceof ResultAsync) {
      return result.then(data => data.unwrap()) as BlobType
    }

    return result.unwrap()
  } catch (rawError) {
    return handleCatch(rawError, ...additionalCauses).throw()
  }
}
