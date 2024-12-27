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
    return this._promise.then(successCallback, failureCallback)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Err<never, N, C>, T> {
    const result = await this._promise

    if (result.isErr()) {
      // @ts-expect-error -- This is structurally equivalent and safe
      yield errAsync(result.error)
    }

    // @ts-expect-error -- This is structurally equivalent and safe
    return result.value
  }
}

/**
 * Shortcut for creating successful AsyncResult
 */
export const okAsync = <T>(value: T): ResultAsync<T, never, never> =>
  new ResultAsync(Promise.resolve(new Ok<T, never, never>(value)))

/**
 * Shortcut for creating failed AsyncResult
 */
export const errAsync = <N extends Std.ErrorValues>(
  err: N,
  message = ''
): ResultAsync<never, N, never> =>
  new ResultAsync(Promise.resolve(new Err<never, N, never>(err, message)))
