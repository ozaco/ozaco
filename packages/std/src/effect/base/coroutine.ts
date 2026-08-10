import type { Operation } from '../types/operation'

import { useCoroutine } from './hooks'

/**
 * Mark a region as critical: an `unwind()` requested while inside it is deferred (the region runs
 * to completion) instead of early-returning. Used to guarantee teardown (e.g. scope destroy)
 * finishes even when the enclosing coroutine is being halted.
 */
export function* critical<T>(operation: () => Operation<T>): Operation<T> {
  const routine = yield* useCoroutine()

  const original = routine.data.critical
  routine.data.critical = true
  try {
    return yield* operation()
  } finally {
    routine.data.critical = original
  }
}
