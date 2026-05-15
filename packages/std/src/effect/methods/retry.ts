import { fail, isFailure } from 'std:result'

import { box } from '../internal/box'
import type { Operation } from '../types/operation'
import type { RetryOptions } from '../types/utils'

import { sleep } from './sleep'

export function* retry<T, E>(
  op: () => Operation<T, E>,
  options: RetryOptions = {},
): Operation<T, E> {
  const { attempts = 3, delay = 0, backoff = 1, maxDelay = 30_000, when } = options

  let currentDelay = delay
  let lastError: unknown

  for (let i = 0; i < attempts; i++) {
    const result = yield* box(op)

    if (isFailure(result)) {
      lastError = result.error
      if (when && !when(result)) {
        throw result
      }

      if (i < attempts - 1) {
        if (currentDelay > 0) {
          yield* sleep(Math.min(currentDelay, maxDelay))
        }
        currentDelay *= backoff
      } else {
        throw result
      }
    } else {
      return result.value
    }
  }

  throw fail(lastError, 'retry exhausted')
}
