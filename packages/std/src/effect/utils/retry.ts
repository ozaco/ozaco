import { appendCauses, isFailure } from 'std:result'

import type { Operation } from '../types/operation'
import type { Utils } from '../types/utils'

import { attempt } from './attempt'
import { sleep } from './sleep'

/**
 * Compute the exponential-backoff delay for a 1-based attempt number:
 * `min(delayMs * factor^(attempt-1), maxDelayMs)`, minus a random 0..`jitter` fraction of itself.
 * Deterministic when `jitter` is 0 (the default).
 */
export const backoffDelay = (attemptNumber: number, options: Utils.BackoffOptions = {}): number => {
  const delayMs = options.delayMs ?? 250
  const factor = options.factor ?? 2
  const maxDelayMs = options.maxDelayMs ?? 30_000
  const jitter = options.jitter ?? 0

  const exponent = Math.max(1, Math.floor(attemptNumber)) - 1
  const base = Math.min(delayMs * factor ** exponent, maxDelayMs)

  if (jitter <= 0) {
    return base
  }

  const random = options.random ?? Math.random
  return base * (1 - jitter + jitter * random())
}

/** Bind {@link backoffDelay} to a fixed set of options: `(attempt) => delayMs`. */
export const backoff =
  (options: Utils.BackoffOptions = {}) =>
  (attemptNumber: number): number =>
    backoffDelay(attemptNumber, options)

/**
 * Run `op` up to `attempts` times (default 3), sleeping {@link backoffDelay} between tries. A
 * `when` predicate can stop retrying early for non-transient failures. When retries are exhausted
 * (or refused), the LAST failure is re-raised with a `retry: n attempts exhausted` cause appended.
 */
export function* retry<T>(op: () => Operation<T>, options: Utils.RetryOptions = {}): Operation<T> {
  const attempts = Math.max(1, options.attempts ?? 3)

  let tried = 0
  while (true) {
    tried += 1

    const result = yield* attempt(op)
    if (!isFailure(result)) {
      return result.value
    }

    const retriable = tried < attempts && (options.when?.(result) ?? true)
    if (!retriable) {
      return yield* appendCauses(result, `retry: ${tried} attempts exhausted`)
    }

    yield* sleep(backoffDelay(tried, options))
  }
}
