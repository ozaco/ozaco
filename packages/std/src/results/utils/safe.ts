import { type BlobType, isPromise } from '../../shared'

import { resultTags } from '../tag'
import { handleCatch, handleThen } from './internal/handlers'

const invalidUsage = resultTags.get('invalid-usage')
const cause = resultTags.get('safe')

/**
 * Executes the given generator function and returns the result.
 *
 * If the function throws an error, the error is wrapped in a result and returned.
 * If the function returns a result, the result is returned.
 */
export function $safe<A extends BlobType[], R, R2, C extends Std.ErrorValues[] = []>(
  body: (...args: A) => Generator<R, R2>,
  ...additionalCauses: C
): Std.Middleware<
  A,
  Std.InjectError<
    Std.UnionsToResult<R | R2>,
    typeof invalidUsage,
    C extends never ? (typeof cause)[] : (typeof cause)[] | C
  >
>
export function $safe<A extends BlobType[], R, R2, C extends Std.ErrorValues[] = []>(
  body: (...args: A) => AsyncGenerator<R, R2>,
  ...additionalCauses: C
): Std.Middleware<
  A,
  Std.InjectError<
    Std.UnionsToResult<
      (R extends never ? never : Promise<R>) | (R2 extends never ? never : Promise<R2>)
    >,
    typeof invalidUsage,
    C extends never ? (typeof cause)[] : (typeof cause)[] | C
  >
>
export function $safe<A extends BlobType[], R, R2, R3, R4, C extends Std.ErrorValues[] = []>(
  body: ((...args: A) => AsyncGenerator<R, R2>) | ((...args: A) => Generator<R3, R4>),
  ...additionalCauses: C
): Std.Middleware<
  A,
  Std.InjectError<
    Std.UnionsToResult<
      (R extends never ? never : Promise<R>) | (R2 extends never ? never : Promise<R2>) | R3 | R4
    >,
    typeof invalidUsage,
    C extends never ? (typeof cause)[] : (typeof cause)[] | C
  >
> {
  const result = ((...args: A) => {
    try {
      const data = body(...args).next()

      if (isPromise(data)) {
        return handleThen(
          data.then(v => v.value),
          ...additionalCauses
        ) as BlobType
      }

      return handleThen(data.value, ...additionalCauses) as BlobType
    } catch (rawError) {
      return handleCatch(rawError, ...additionalCauses) as BlobType
    }
  }) as BlobType

  result.addCauses = (...newAdditionalCauses: BlobType[]) => {
    return $safe(body as BlobType, ...additionalCauses, ...newAdditionalCauses) as BlobType
  }

  return result
}
