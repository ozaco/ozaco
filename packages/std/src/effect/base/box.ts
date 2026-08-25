import type { Result } from 'std:result'
import { asFailure, succeed } from 'std:result'

import type { Operation } from '../types/operation'

/**
 * Evaluate `op` and capture its outcome as a `Result` VALUE — success and failure both return
 * normally.
 */
export function* box<T>(op: () => Operation<T>): Operation<Result<T>> {
  try {
    return succeed(yield* op()) as Result<T>
  } catch (error) {
    return asFailure(error)
  }
}
