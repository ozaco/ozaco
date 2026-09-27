import type { Result } from 'std:result'
import { isFailure } from 'std:result'

import { ABSORB_DEPTH, ABSORB_LEVELS, CHAIN_DEPTH, CHAIN_LEVELS } from './const'

/**
 * A failure and the failures nested in its causes, depth first (a failure before what it wraps,
 * its causes in stored order): at most `depth` levels deep and `limit` failures in all; a failure
 * met again (a cycle, one shared twice) is walked once.
 */
export const chainOf = (
  start: Result.Failure<unknown>,
  depth = CHAIN_DEPTH,
  limit = CHAIN_LEVELS,
): Result.Failure<unknown>[] => {
  const out: Result.Failure<unknown>[] = []
  const seen = new Set<unknown>()

  const visit = (failure: Result.Failure<unknown>, level: number): void => {
    if (seen.has(failure) || out.length >= limit) {
      return
    }

    seen.add(failure)
    out.push(failure)

    if (level < depth && Array.isArray(failure.causes)) {
      for (const cause of failure.causes) {
        if (isFailure(cause)) {
          visit(cause, level + 1)
        }
      }
    }
  }

  visit(start, 1)

  return out
}

/** What `outer` wraps, however deep in its causes: the nested failures (a pending failure is
 * wrapped when it is one of them). */
export const nestedIn = (outer: Result.Failure<unknown>): Set<unknown> =>
  new Set(chainOf(outer, ABSORB_DEPTH, ABSORB_LEVELS).slice(1))
