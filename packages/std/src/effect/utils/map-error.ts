import type { Result } from 'std:result'
import { isFailure } from 'std:result'

import { attempt } from '../base/attempt'
import type { Operation } from '../types/operation'

export function* mapError<T>(
  op: Operation<T>,
  mapper: (failure: Result.Failure<unknown>) => Result.Failure<unknown>,
): Operation<T> {
  const result = yield* attempt(() => op)

  if (isFailure(result)) {
    throw mapper(result)
  }

  return result.value
}
