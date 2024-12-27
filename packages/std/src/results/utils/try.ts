import { type BlobType, isPromise } from '../../shared'

import { resultTags } from '../tag'
import { handleCatch, handleThen } from './internal/handlers'

const invalidUsage = resultTags.get('invalid-usage')
const cause = resultTags.get('try')

/**
 * Executes the given generator function and returns the result.
 *
 * If the function throws an error, the error is wrapped in a result and returned.
 * If the function returns a result, the result is returned.
 */
export function $try<R, R2, C extends Std.ErrorValues[] = []>(
  body: () => Generator<R, R2>,
  ...additionalCauses: C
): Std.InjectError<
  Std.UnionsToResult<R | R2>,
  typeof invalidUsage,
  C extends never ? (typeof cause)[] : (typeof cause)[] | C
>
export function $try<R, R2, C extends Std.ErrorValues[] = []>(
  body: () => AsyncGenerator<R, R2>,
  ...additionalCauses: C
): Std.InjectError<
  Std.UnionsToResult<
    (R extends never ? never : Promise<R>) | (R2 extends never ? never : Promise<R2>)
  >,
  typeof invalidUsage,
  C extends never ? (typeof cause)[] : (typeof cause)[] | C
>
export function $try<R, R2, R3, R4, C extends Std.ErrorValues[] = []>(
  body: (() => AsyncGenerator<R, R2>) | (() => Generator<R3, R4>),
  ...additionalCauses: C
): Std.InjectError<
  Std.UnionsToResult<
    (R extends never ? never : Promise<R>) | (R2 extends never ? never : Promise<R2>) | R3 | R4
  >,
  typeof invalidUsage,
  C extends never ? (typeof cause)[] : (typeof cause)[] | C
> {
  try {
    const result = body().next()

    if (isPromise(result)) {
      return handleThen(
        result.then(v => v.value),
        ...additionalCauses
      ) as BlobType
    }

    return handleThen(result.value, ...additionalCauses) as BlobType
  } catch (rawError) {
    return handleCatch(rawError, ...additionalCauses) as BlobType
  }
}
