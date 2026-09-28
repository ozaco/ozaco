import { serializeError } from 'std:shared'

import type { ResultDef } from '../types/def'
import type { Result } from '../types/result'
import { isFailure } from '../utils/is'

/**
 * A failure and every failure nested in its causes, depth first (a failure before what it wraps,
 * its causes in stored order); a failure met again (a cycle, one shared twice) is walked once.
 */
export const walk = (start: Result.Failure<unknown>): Result.Failure<unknown>[] => {
  const out: Result.Failure<unknown>[] = []
  const seen = new Set<unknown>()
  // an explicit stack, not recursion: a chain of any depth never overflows the call stack
  const stack: Result.Failure<unknown>[] = [start]

  while (stack.length > 0) {
    const failure = stack.pop() as Result.Failure<unknown>

    if (seen.has(failure)) {
      continue
    }

    seen.add(failure)
    out.push(failure)

    const nested = Array.isArray(failure.causes) ? failure.causes.filter(isFailure) : []

    // pushed last-first, so the first nested failure is walked next (depth first, stored order)
    for (let index = nested.length - 1; index >= 0; index -= 1) {
      stack.push(nested[index] as Result.Failure<unknown>)
    }
  }

  return out
}

/** One failure read as a chain level. */
export const levelOf = (failure: Result.Failure<unknown>): ResultDef.Level => ({
  type: serializeError(failure.error),
  message: failure.message,
  causes: Array.isArray(failure.causes)
    ? failure.causes.filter((cause): cause is string => typeof cause === 'string')
    : [],
})
