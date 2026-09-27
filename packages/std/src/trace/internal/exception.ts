import type { Result } from 'std:result'
import { serializeError } from 'std:shared'

/** One level's `<type>`: the tag (a non-string error as its `serializeError` text). */
export const levelType = (failure: Result.Failure<unknown>): string =>
  typeof failure.error === 'string' ? failure.error : serializeError(failure.error)
