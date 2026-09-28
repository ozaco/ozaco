import type { Result } from 'std:result'
import { formatFailure } from 'std:result'
import { serializeError } from 'std:shared'

import type { TraceDef } from '../types/trace'

import { chainOf } from './chain'
import { MAX_ARRAY_ITEMS } from './const'

/**
 * `ozaco.failure.chain`: `<type>: <message>` per failure, the failure first, then the failures
 * nested in its causes depth first — as many as an array value keeps (the generic item cap).
 */
const failureChain = (failure: Result.Failure<unknown>): string[] =>
  // only the levels an array value keeps are rendered (the generic item cap)
  chainOf(failure)
    .slice(0, MAX_ARRAY_ITEMS)
    .map(level => {
      const type = serializeError(level.error)

      return level.message ? `${type}: ${level.message}` : type
    })

/** `exception.type`: the failure's tag (a non-string error as its `serializeError` text). */
export const exceptionType = (failure: Result.Failure<unknown>): string =>
  serializeError(failure.error)

/**
 * The attributes of an `exception` span event / exception log record: `exception.type`,
 * `exception.message`, `exception.stacktrace` (the whole chain, `formatFailure(f, { chain: true })`),
 * `ozaco.failure.chain` (ALWAYS, even for one level) and
 * `ozaco.failure.causes` (the failure's own string causes — left out when it has none: an empty
 * array is no value every sink keeps). No `error.type` — that lives on the span.
 */
export const exceptionAttributes = (failure: Result.Failure<unknown>): TraceDef.Attributes => {
  const type = exceptionType(failure)
  const message = failure.message || type
  const causes = failure.causes.filter((cause): cause is string => typeof cause === 'string')

  return {
    'exception.type': type,
    'exception.message': message,
    'exception.stacktrace': formatFailure(failure, { chain: true }),
    'ozaco.failure.chain': failureChain(failure),
    ...(causes.length > 0 ? { 'ozaco.failure.causes': causes } : {}),
  }
}
