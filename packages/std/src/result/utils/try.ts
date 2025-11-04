import { type BlobType, isPromise } from 'std:shared'

import type { ExtractResultAsync, ExtractResultBoth, Result, ResultAsync } from '../types'
import { handle, handleAsync, handleError } from './handle'

export function $try<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => ExtractResultAsync<Value, Name>,
  ...causes: Cause[]
): ResultAsync<Value, Cause | Name>

export function $try<
  Args extends BlobType[],
  Value,
  AsyncValue = never,
  AsyncName extends string = never,
  Name extends string = never,
  Cause extends string = never,
>(
  cb: (...args: Args) => ExtractResultBoth<Value, AsyncValue, Name, AsyncName>,
  ...causes: Cause[]
): Result<Value, Cause | Name> | ResultAsync<AsyncValue, Cause | AsyncName>

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
