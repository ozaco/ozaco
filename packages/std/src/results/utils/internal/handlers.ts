import { type BlobType, isPromise } from '../../../shared'

import { resultTags } from '../../tag'
import { ResultAsync } from '../async'
import { Err, err } from '../err'
import { Ok, ok } from '../ok'

const invalidUsage = resultTags.get('invalid-usage')

/**
 * This helper extracts the actual value from its first argument
 */
export const handleThen = (
  result: BlobType,
  ...additionalCauses: Std.ErrorValues[]
): Std.Both<BlobType, BlobType, BlobType> => {
  if (isPromise(result) && !(result instanceof ResultAsync)) {
    return new ResultAsync(
      (result as Promise<BlobType>).then(
        data => handleThen(data, ...additionalCauses),
        e => handleCatch(e, ...additionalCauses)
      )
    )
  }

  const isOk = result instanceof Ok
  const isErr = result instanceof Err

  if (!(isOk || isErr)) {
    return ok(result)
  }

  if (isErr) {
    return handleCatch(result, ...additionalCauses)
  }

  return result
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
