import { ServerErrors } from 'server:core'
import type { Operation } from 'std:effect'
import { sleep } from 'std:effect'
import { fail } from 'std:result'

import type { TestingDef } from '../types'

/**
 * Ask `pick` until it answers something other than `undefined` — a row that should appear, a
 * counter that should move, a record a sink should hold — every `everyMs` (default 10), giving
 * up with `server.timeout-unreached` after `timeoutMs` (default 2000). The hand-written
 * `for (;;) { if (found) break; await sleep(10) }` of a test, with a deadline.
 */
export function* eventually<T>(
  pick: () => T | undefined,
  options?: TestingDef.EventuallyOptions,
): Operation<T> {
  const timeoutMs = options?.timeoutMs ?? 2000
  const everyMs = options?.everyMs ?? 10
  const started = Date.now()

  for (;;) {
    const found = pick()

    if (found !== undefined) {
      return found
    }

    if (Date.now() - started > timeoutMs) {
      return yield* fail(
        ServerErrors.TimeoutUnreached,
        `eventually: nothing was picked within ${timeoutMs}ms`,
      )
    }

    yield* sleep(everyMs)
  }
}
