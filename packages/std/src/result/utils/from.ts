import { type BlobType, isPromise } from '@shared'
import type { Err, Result, ResultAsync } from '../types'
import { handleAsync } from './handle'
import { auto } from './result'

export function $from<Args extends BlobType[], Value, Handler extends Err<BlobType>, Cause extends string = never>(
  cb: (...args: Args) => PromiseLike<Value>,
  handler: (error: unknown) => Handler,
  ...causes: Cause[]
): (...args: Args) => ResultAsync<Value, Handler['_n'] | Cause>

export function $from<Args extends BlobType[], Value, Handler extends Err<BlobType>, Cause extends string = never>(
  cb: (...args: Args) => Value,
  handler: (error: unknown) => Handler,
  ...causes: Cause[]
): (...args: Args) => Result<Value, Handler['_n'] | Cause>

export function $from(cb: (...args: BlobType[]) => BlobType, handler: (error: unknown) => Err<BlobType>) {
  return (...args: BlobType[]) => {
    try {
      const out = cb(...args)

      if (isPromise(out)) {
        const result = out.then(
          out => auto(out),
          e => handler(e),
        )

        handleAsync(result)

        return result
      }

      return auto(out)
    } catch (e) {
      return handler(e)
    }
  }
}
