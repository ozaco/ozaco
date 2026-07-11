import { fail, isFailure } from 'std:result'

import type { Operation } from '../types/operation'
import type { RetryOptions } from '../types/utils'

import { attempt } from './attempt'
import { sleep } from './sleep'

export function* retry<T>(op: () => Operation<T>, options: RetryOptions = {}): Operation<T> {
  const { attempts = 3, delay = 0, backoff = 1, maxDelay = 30_000, when } = options

  let currentDelay = delay
  let lastError: unknown

  for (let i = 0; i < attempts; i++) {
    const result = yield* attempt(op)

    if (isFailure(result)) {
      lastError = result.error
      if (when && !when(result)) {
        throw result
      }

      if (i < attempts - 1) {
        if (currentDelay > 0) {
          yield* sleep(Math.min(currentDelay, maxDelay))
        }
        currentDelay = Math.min(currentDelay * backoff, maxDelay)
      } else {
        throw result
      }
    } else {
      return result.value
    }
  }

  throw fail(lastError, 'retry exhausted')
}
