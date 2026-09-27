import { serializeError } from 'std:shared'

import type { ResultDef } from '../types/def'
import type { Result } from '../types/result'
import { isFailure } from '../utils/is'

/** The failures nested in `failure`'s causes, in stored order. */
const nestedOf = (failure: Result.Failure<unknown>): Result.Failure<unknown>[] =>
  Array.isArray(failure.causes) ? failure.causes.filter(isFailure) : []

/**
 * A failure and the failures nested in its causes, depth first (a failure before what it wraps,
 * its causes in stored order): at most `depth` levels deep and `limit` failures in all; a failure
 * met again (a cycle, one shared twice) is walked once.
 */
export const walk = (
  start: Result.Failure<unknown>,
  depth: number,
  limit: number,
): Result.Failure<unknown>[] => {
  const out: Result.Failure<unknown>[] = []
  const seen = new Set<unknown>()

  const visit = (failure: Result.Failure<unknown>, level: number): void => {
    if (seen.has(failure) || out.length >= limit) {
      return
    }

    seen.add(failure)
    out.push(failure)

    if (level < depth) {
      for (const nested of nestedOf(failure)) {
        visit(nested, level + 1)
      }
    }
  }

  visit(start, 1)

  return out
}

/** One failure read as a chain level. */
export const levelOf = (failure: Result.Failure<unknown>): ResultDef.Level => ({
  type: typeof failure.error === 'string' ? failure.error : serializeError(failure.error),
  message: failure.message,
  causes: Array.isArray(failure.causes)
    ? failure.causes.filter((cause): cause is string => typeof cause === 'string')
    : [],
})
