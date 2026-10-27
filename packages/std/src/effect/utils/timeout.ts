import { fail } from 'std:result'

import { race } from '../base/race'
import { EffectErrors } from '../errors'
import type { Operation } from '../types/operation'
import type { Utils } from '../types/utils'

import { sleep } from './sleep'

/**
 * `op` with a deadline: its value when it settles within `ms`, else `std:effect.timeout` — the
 * body is halted (its `finally` blocks run), nothing of it leaks past the deadline.
 */
export function* timeout<T>(
  op: () => Operation<T>,
  ms: number,
  options?: Utils.TimeoutOptions,
): Operation<T> {
  function* done(): Operation<{ readonly late: false; readonly value: T }> {
    return { late: false, value: yield* op() }
  }

  function* late(): Operation<{ readonly late: true }> {
    yield* sleep(ms)

    return { late: true }
  }

  const outcome = yield* race([done(), late()])

  if (!outcome.late) {
    return outcome.value
  }

  return yield* fail(
    EffectErrors.Timeout,
    `${options?.name ?? 'operation'} timed out after ${ms}ms`,
  )
}
