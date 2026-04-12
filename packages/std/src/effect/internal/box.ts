import type { Result } from 'std:result'
import { asFailure, succeed } from 'std:result'

import type { Operation } from '../types/operation'

export function* box<T, E = unknown>(op: () => Operation<T, E>): Operation<Result<T, E>> {
  try {
    return succeed(yield* op() as Operation<T>) as Result<T, E>
  } catch (error) {
    return asFailure(error) as Result<T, E>
  }
}
