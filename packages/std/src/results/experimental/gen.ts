import { err, resultTags } from '../../results'
import type { AsyncGeneratorFn, BlobType, Fn, GeneratorFn } from '../../shared'

import { handleThen, handleCatch } from '../utils/internal/handlers'

const invalidUsage = resultTags.get('invalid-usage')

/**
 * @experimental
 *
 * The $gen function is used to wrap a generator function
 * and automatically handles the error cases, yielding and returning
 * Result or ResultAsync instances.
 */
export const $gen = <
  A extends BlobType[],
  G extends Generator<BlobType, BlobType, BlobType> | AsyncGenerator<BlobType, BlobType, BlobType>,
  C extends Std.ErrorValues[] = [],
>(
  genFn: Fn<A, G>,
  ...additionalCauses: C
): G extends AsyncGenerator<infer Y, infer R, infer N>
  ? AsyncGeneratorFn<
      A,
      Std.InjectedResult<Y, typeof invalidUsage, C>,
      Std.InjectedResult<R, typeof invalidUsage, C>,
      N
    >
  : G extends Generator<infer Y, infer R, infer N>
    ? GeneratorFn<
        A,
        Std.InjectedResult<Y, typeof invalidUsage, C>,
        Std.InjectedResult<R, typeof invalidUsage, C>,
        N
      >
    : never => {
  return ((...args: A) => {
    let generator: BlobType

    let earlyReturn: Std.Both<BlobType, BlobType, BlobType[]> | undefined

    try {
      generator = genFn(...args)
    } catch (rawError) {
      earlyReturn = handleCatch(rawError, ...additionalCauses)
    }

    if (generator?.[Symbol.asyncIterator]) {
      return (async function* () {
        if (earlyReturn) {
          return earlyReturn
        }

        let nextResult: IteratorResult<BlobType, BlobType>
        try {
          nextResult = await generator.next()
        } catch (rawError) {
          yield handleCatch(rawError, ...additionalCauses)
          return
        }

        while (!nextResult.done) {
          try {
            const handledYield = handleThen(nextResult.value, ...additionalCauses)

            yield handledYield

            nextResult = await generator.next()
          } catch (rawError) {
            yield handleCatch(rawError, ...additionalCauses)
            return
          }
        }

        try {
          const handledReturn = handleThen(nextResult.value, ...additionalCauses)

          return handledReturn
        } catch (rawError) {
          yield handleCatch(rawError, ...additionalCauses)
          return
        }
      })()
    }

    if (generator?.[Symbol.iterator]) {
      return (function* () {
        if (earlyReturn) {
          return earlyReturn
        }

        let nextResult: IteratorResult<BlobType, BlobType>
        try {
          nextResult = (generator as Generator<BlobType, BlobType, BlobType>).next()
        } catch (rawError) {
          yield handleCatch(rawError, ...additionalCauses)
          return
        }

        while (!nextResult.done) {
          try {
            const handledYield = handleThen(nextResult.value, ...additionalCauses)

            yield handledYield

            nextResult = (generator as Generator<BlobType, BlobType, BlobType>).next()
          } catch (rawError) {
            yield handleCatch(rawError, ...additionalCauses)
            return
          }
        }

        try {
          const handledReturn = handleThen(nextResult.value, ...additionalCauses)

          return handledReturn
        } catch (rawError) {
          yield handleCatch(rawError, ...additionalCauses)
          return
        }
      })()
    }

    return err(invalidUsage, 'generator function is not a generator').throw()
  }) as BlobType
}
