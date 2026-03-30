import type { Result } from 'std:result'
import { fail, succeed } from 'std:result'

import type { Operation } from '../types/operation'

export function* box<T>(op: () => Operation<T>): Operation<Result<T, unknown>> {
  try {
    return succeed(yield* op()) as Result<T, unknown>
  } catch (error) {
    return fail(error)
  }
}
