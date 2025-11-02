import type { BlobType } from '../shared'
import { isPromise } from '../shared/utils/is'
import { handle, handleAsync, handleError } from './handle'
import type { Err, Result, ResultAsync } from './types'

export function $safe<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => AsyncGenerator<Err<Name>, Result<Value | Err<Name>, Name>>,
  ...causes: Cause[]
): (...args: Args) => ResultAsync<Value, Cause | Name>
export function $safe<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => AsyncGenerator<Err<Name>, Value | Err<Name>>,
  ...causes: Cause[]
): (...args: Args) => ResultAsync<Value, Cause | Name>
export function $safe<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => Generator<Err<Name>, Result<Value | Err<Name>, Name>>,
  ...causes: Cause[]
): (...args: Args) => Result<Value, Cause | Name>
export function $safe<Args extends BlobType[], Value, Name extends string = never, Cause extends string = never>(
  cb: (...args: Args) => Generator<Err<Name>, Value | Err<Name>>,
  ...causes: Cause[]
): (...args: Args) => Result<Value, Cause | Name>
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

      return handle(out, causes)
    } catch (e) {
      return handleError(e, causes)
    }
  }
}
