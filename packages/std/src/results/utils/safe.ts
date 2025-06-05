import { type BlobType, type Fn, isPromise } from '../../shared'

import { resultTags } from '../tag'
import { handleCatch, handleThen } from './internal/handlers'

const invalidUsage = resultTags.get('invalid-usage')
const cause = resultTags.get('safe')

/**
 * The $safe function is used to wrap a generator function that returns a Result or ResultAsync
 * and automatically handles the error cases.
 * yield* can be used to automatically unwrap results.
 * Don't use yield to return a value. Use return instead. This function doesn't return a generator.
 */
export function $safe<A extends BlobType[], R, R2, C extends Std.ErrorValues[] = []>(
  body: (...args: A) => Generator<R, R2>,
  ...additionalCauses: C
): Fn<
  A,
  Std.InjectedResult<
    R | R2,
    typeof invalidUsage,
    C extends never ? (typeof cause)[] : (typeof cause)[] | C
  >
>
export function $safe<A extends BlobType[], R, R2, C extends Std.ErrorValues[] = []>(
  body: (...args: A) => AsyncGenerator<R, R2>,
  ...additionalCauses: C
): Fn<
  A,
  Std.InjectedResult<
    (R extends never ? never : Promise<R>) | (R2 extends never ? never : Promise<R2>),
    typeof invalidUsage,
    C extends never ? (typeof cause)[] : (typeof cause)[] | C
  >
>
export function $safe<A extends BlobType[], R, R2, R3, R4, C extends Std.ErrorValues[] = []>(
  body: ((...args: A) => AsyncGenerator<R, R2>) | ((...args: A) => Generator<R3, R4>),
  ...additionalCauses: C
): Fn<
  A,
  Std.InjectedResult<
    (R extends never ? never : Promise<R>) | (R2 extends never ? never : Promise<R2>) | R3 | R4,
    typeof invalidUsage,
    C extends never ? (typeof cause)[] : (typeof cause)[] | C
  >
> {
  return ((...args: A) => {
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
}
