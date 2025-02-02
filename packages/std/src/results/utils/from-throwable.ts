import { type BlobType, isPromise } from '../../shared'

import { ResultAsync } from './async'
import { Ok } from './ok'

export const fromThrowable = <
  A extends BlobType[],
  T,
  R extends Std.Both<BlobType, BlobType, BlobType>,
>(
  fn: (...args: A) => T,
  errorFn: (err: unknown) => R
) => {
  return ((...args: A) => {
    try {
      const result = fn(...args)

      if (isPromise(result) && !(result instanceof ResultAsync)) {
        return new ResultAsync(
          (result as unknown as Promise<BlobType>).then(
            data => new Ok(data) as Std.Result<BlobType, BlobType, BlobType>,
            e => errorFn(e)
          )
        )
      }

      return new Ok(result) as Std.Result<BlobType, BlobType, BlobType>
    } catch (rawError) {
      return errorFn(rawError)
    }
  }) as Std.FromThrowable<A, T, R>
}
