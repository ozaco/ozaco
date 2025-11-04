import { type BlobType, isPromise } from 'std:shared'

import type { Err, ExtractResultBoth, Result, ResultAsync } from '../types'
import { handle, handleAsync, handleError } from './handle'

export function $safe<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => AsyncGenerator<Err<Name>, ExtractResultBoth<Value, Value, Name, Name>>,
  ...causes: Cause[]
): (...args: Args) => ResultAsync<Value, Cause | Name>

export function $safe<
  Args extends BlobType[],
  Value,
  AsyncValue = never,
  Name extends string = never,
  AsyncName extends string = never,
  Cause extends string = never,
>(
  cb: (...args: Args) => Generator<Err<Name>, ExtractResultBoth<Value, AsyncValue, Name, AsyncName>>,
  ...causes: Cause[]
): (...args: Args) => Result<Value, Cause | Name> | ResultAsync<AsyncValue, Cause | AsyncName>

export function $safe(cb: (...args: BlobType[]) => BlobType, ...causes: string[]) {
  return (...args: BlobType[]) => {
    try {
      const out = cb(...args).next()

      if (isPromise(out)) {
        const result = out.then(
          out => handle(out.value, causes),
          e => handleError(e, causes),
        )

        handleAsync(result)

        return result
      }

      return handle(out.value, causes)
    } catch (e) {
      return handleError(e, causes)
    }
  }
}
