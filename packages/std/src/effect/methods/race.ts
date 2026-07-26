import type { Result } from 'std:result'
import { asFailure, fail, succeed, unwrap } from 'std:result'

import { trap } from '../internal/trap'
import type { Helpers } from '../types/helpers'
import type { Operation, Task } from '../types/operation'

import { spawn } from './spawn'
import { withResolvers } from './with-resolvers'

export function* race<T extends Operation<unknown>>(
  operations: readonly T[],
): Operation<Helpers.Yielded<T>> {
  if (operations.length === 0) {
    throw fail('race', 'race() requires at least one operation')
  }

  const winner = withResolvers<Result<Helpers.Yielded<T>, unknown>>('await winner')

  const tasks: Task<unknown>[] = []

  try {
    const settled = yield* trap(function* () {
      for (const operation of operations.slice()) {
        tasks.push(
          yield* spawn(function* candidate() {
            try {
              const value = yield* operation
              winner.resolve(succeed(value) as Result<Helpers.Yielded<T>, unknown>)
            } catch (error) {
              winner.resolve(asFailure(error))
            }
          }),
        )
      }
      return yield* winner.operation
    })

    return unwrap(settled)
  } finally {
    /**
     * Shut the losers down HOWEVER this ends — and a `finally` is the only place that does.
     *
     * As a plain step after the trap it is skipped whenever the WINNING operation failed, because
     * `trap` re-raises a captured failure out of its own `finally`. That is not a corner case: it is
     * exactly what a timeout looks like — the `expired()` branch wins by FAILING, so the losing
     * body kept running with nobody waiting for it. Measured with a losing `sleep(400)` still firing
     * long after the race had thrown.
     *
     * An `ensure` is worse: race creates no scope of its own, so the cleanup would bind to the
     * CALLER's scope and not run until the caller ends.
     */
    const shutdown: Task<void>[] = []

    for (const task of tasks) {
      shutdown.push(yield* spawn(() => task.halt()))
    }

    for (const task of shutdown) {
      yield* task
    }
  }
}
