import type { BlobType } from '../../shared'

import { Err } from './err'
import { Ok } from './ok'

/**
 * This class converts a promise into ResultAsync
 */
export class ResultAsync<T, N extends Std.ErrorValues = never, C extends Std.ErrorValues[] = []>
  implements PromiseLike<Std.Result<T, N, C>>
{
  private _promise: Promise<Std.Result<T, N, C>>

  constructor(res: Promise<Std.Result<T, N, C>>) {
    this._promise = res
  }

  // Makes ResultAsync implement PromiseLike<Result>
  // biome-ignore lint/suspicious/noThenProperty: Redundant
  then<A, B>(
    successCallback?: (res: Std.Result<T, N, C>) => A | PromiseLike<A>,
    failureCallback?: (reason: unknown) => B | PromiseLike<B>
  ): PromiseLike<A | B> {
    return this._promise
      .then(r => {
        if (r instanceof Ok && r.value instanceof ResultAsync) {
          return r.value
        }

        return r
      })
      .then(successCallback, failureCallback)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Err<never, N, C>, T> {
    const result = await this._promise

    if (result.isErr()) {
      // @ts-expect-error -- This is structurally equivalent and safe
      yield new ResultAsync(Promise.resolve(result.error))
    }

    // @ts-expect-error -- This is structurally equivalent and safe
    return result.value
  }
}

/**
 * Shortcut for creating successful AsyncResult
 */
export const okAsync = <T>(value: T) =>
  new ResultAsync(Promise.resolve(new Ok(value))) as T extends ResultAsync<
    BlobType,
    BlobType,
    BlobType
  >
    ? T
    : ResultAsync<
        T extends Ok<infer T2, BlobType, BlobType>
          ? T2
          : T extends ResultAsync<infer T2, never, never>
            ? T2
            : T,
        never,
        never
      >

/**
 * Shortcut for creating failed AsyncResult
 */
export const errAsync = <N extends Std.ErrorValues>(
  err: N,
  message = ''
): ResultAsync<never, N, never> =>
  new ResultAsync(Promise.resolve(new Err<never, N, never>(err, message)))
