import { type BlobType, isPromise } from '@shared'
import type { Err, Result, ResultAsync } from '../types'
import { handle, handleAsync, handleError } from './handle'

export function $try<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => PromiseLike<Result<Value | Err<Name>, Name>>,
  ...causes: Cause[]
): ResultAsync<Value, Cause | Name>

export function $try<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => PromiseLike<Value | Err<Name>>,
  ...causes: Cause[]
): ResultAsync<Value, Cause | Name>

export function $try<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => Result<Value | Err<Name>, Name>,
  ...causes: Cause[]
): Result<Value, Cause | Name>

export function $try<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => Value | Err<Name>,
  ...causes: Cause[]
): Result<Value, Cause | Name>

export function $try(cb: (...args: BlobType[]) => BlobType, ...causes: string[]) {
  try {
    const out = cb()

    if (isPromise(out)) {
      const result = out.then(
        out => handle(out, causes),
        e => handleError(e, causes),
      )

      handleAsync(result)

      return result
    }

    return handle(out, causes)
  } catch (e) {
    return handleError(e, causes)
  }
}
