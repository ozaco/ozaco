import { type BlobType, isPromise } from '../../../shared'

import { resultTags } from '../../tag'
import { ResultAsync } from '../async'
import { Err, err } from '../err'
import { Ok, ok } from '../ok'

const invalidUsage = resultTags.get('invalid-usage')

/**
 * This helper extracts the actual value from its first argument (even its nested ok's or okAsync)
 */
export const handleThen = (
  data: BlobType,
  ...additionalCauses: Std.ErrorValues[]
): Std.Result<BlobType, BlobType, BlobType> | ResultAsync<BlobType, BlobType, BlobType> => {
  if (isPromise(data)) {
    return new ResultAsync(
      data.then(
        async (rawData: BlobType) => {
          const data = rawData.value ?? rawData

          let result = data

          while (isPromise(result)) {
            const awaited = await result
            result = awaited.value ?? awaited

            if (awaited instanceof Err) {
              return handleCatch(awaited, ...additionalCauses)
            }

            if (awaited instanceof Ok) {
              break
            }
          }

          return handleThen(result, ...additionalCauses)
        },
        e => handleCatch(e, ...additionalCauses)
      ) as BlobType
    )
  }

  let result = data

  while (result instanceof Ok) {
    result = result.value ?? result
  }

  if (result instanceof ResultAsync) {
    return handleThen(result, ...additionalCauses)
  }

  if (result instanceof Err) {
    return handleCatch(result, ...additionalCauses)
  }

  return ok(result)
}

/**
 * This helper adds additional causes to an error
 */
export const handleCatch = (
  e: BlobType,
  ...additionalCauses: Std.ErrorValues[]
): Err<BlobType, BlobType, BlobType> => {
  if (e instanceof Err) {
    return e.appendCause(...additionalCauses)
  }

  return err(invalidUsage, 'incorrect usage of handleCatch')
    .appendCause(...additionalCauses)
    .appendData(e)
}
