import { type BlobType, isPromise } from '@shared'

import { handle, handleAsync, handleError } from './handle'
import type { Err, Result, ResultAsync } from './types'

export function $fn<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => PromiseLike<Result<Value | Err<Name>, Name>>,
  ...causes: Cause[]
): (...args: Args) => ResultAsync<Value, Cause | Name>
export function $fn<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => PromiseLike<Value | Err<Name>>,
  ...causes: Cause[]
): (...args: Args) => ResultAsync<Value, Cause | Name>
export function $fn<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => Result<Value | Err<Name>, Name>,
  ...causes: Cause[]
): (...args: Args) => Result<Value, Cause | Name>
export function $fn<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => Value | Err<Name>,
  ...causes: Cause[]
): (...args: Args) => Result<Value, Cause | Name>
export function $fn(cb: (...args: BlobType[]) => BlobType, ...causes: string[]) {
  return (...args: BlobType[]) => {
    try {
      const out = cb(...args)

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
}
