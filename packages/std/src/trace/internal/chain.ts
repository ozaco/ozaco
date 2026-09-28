import type { Result } from 'std:result'
import { isFailure } from 'std:result'

/**
 * A failure and every failure nested in its causes, depth first (a failure before what it wraps,
 * its causes in stored order); a failure met again (a cycle, one shared twice) is walked once.
 */
export const chainOf = (start: Result.Failure<unknown>): Result.Failure<unknown>[] => {
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

/** What `outer` wraps, however deep in its causes: the nested failures (a pending failure is
 * wrapped when it is one of them). */
export const nestedIn = (outer: Result.Failure<unknown>): Set<unknown> =>
  new Set(chainOf(outer).slice(1))
