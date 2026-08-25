import type { Result } from 'std:result'
import { isFailure } from 'std:result'

import type { Operation } from '../types/operation'

import { attempt } from './attempt'

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
