import { type BlobType, isPromise } from 'std:shared'

import type { Err, ExtractResultAsync, ExtractResultBoth, Result, ResultAsync } from '../types'
import { handleAsync } from './handle'
import { auto } from './result'

export function $from<
  Args extends BlobType[],
  Value,
  Handler extends Err<BlobType> = never,
  Cause extends string = never,
>(
  cb: (...args: Args) => ExtractResultAsync<Value, Handler['_n']>,
  handler?: (error: unknown) => Handler,
  ...causes: Cause[]
): (...args: Args) => ResultAsync<Value, Handler['_n'] | Cause>

export function $from<
  Args extends BlobType[],
  Value,
  AsyncValue = never,
  AsyncName extends string = never,
  Handler extends Err<BlobType> = never,
  Cause extends string = never,
>(
  cb: (...args: Args) => ExtractResultBoth<Value, AsyncValue, Handler['_n'], AsyncName>,
  handler?: (error: unknown) => Handler,
  ...causes: Cause[]
): (...args: Args) => Result<Value, Handler['_n'] | Cause> | ResultAsync<AsyncValue, Handler['_n'] | AsyncName>

export function $from(cb: (...args: BlobType[]) => BlobType, handler?: (error: unknown) => Err<BlobType>) {
  return (...args: BlobType[]) => {
    try {
      const out = cb(...args)

      if (isPromise(out)) {
        const result = out.then(
          out => auto(out),
          e => handler?.(e),
        )

        handleAsync(result)

        return result
      }

      return auto(out)
    } catch (e) {
      return handler?.(e)
    }
  }
}
