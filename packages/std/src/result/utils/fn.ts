import { type BlobType, isPromise } from 'std:shared'

import type { ExtractResultAsync, ExtractResultBoth, Result, ResultAsync } from '../types'
import { handle, handleAsync, handleError } from './handle'

export function $fn<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => ExtractResultAsync<Value, Name>,
  ...causes: Cause[]
): (...args: Args) => ResultAsync<Value, Cause | Name>

export function $fn<
  Args extends BlobType[],
  Value,
  AsyncValue = never,
  Name extends string = never,
  AsyncName extends string = never,
  Cause extends string = never,
>(
  cb: (...args: Args) => ExtractResultBoth<Value, AsyncValue, Name, AsyncName>,
  ...causes: Cause[]
): (...args: Args) => Result<Value, Cause | Name> | ResultAsync<AsyncValue, Cause | AsyncName>

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
