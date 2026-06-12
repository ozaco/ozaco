import type { Result } from 'std:result'
import { isFailure } from 'std:result'

import { box } from '../internal/box'
import type { Operation } from '../types/operation'

export function* mapError<T, E1, E2>(
  op: Operation<T, E1>,
  mapper: (failure: Result.Failure<E1>) => Result.Failure<E2>,
): Operation<T, E2> {
  const result = yield* box(() => op)

  if (isFailure(result)) {
    throw mapper(result)
  }

  return result.value
}
