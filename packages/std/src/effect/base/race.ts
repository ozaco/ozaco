import type { Result } from 'std:result'
import { asFailure, succeed, unwrap } from 'std:result'

import { trap } from '../internal/trap'
import type { Operation, Task } from '../types/operation'
import type { Utils } from '../types/utils'

import { spawn } from './spawn'
import { withResolvers } from './with-resolvers'

/**
 * Race the given operations against each other and evaluate to the value of whichever operation
 * wins. Losers are halted before the race returns.
 */
export function* race<T extends Operation<unknown>>(
  operations: readonly T[],
): Operation<Utils.Yielded<T>> {
  const winner = withResolvers<Result<Utils.Yielded<T>>>('await winner')

  const tasks: Task<unknown>[] = []

  const result = yield* trap(function* () {
    for (const operation of operations.slice()) {
      tasks.push(
        yield* spawn(function* candidate() {
          try {
            winner.resolve(succeed(yield* operation) as Result<Utils.Yielded<T>>)
          } catch (error) {
            winner.resolve(asFailure(error))
          }
        }),
      )
    }
    return yield* winner.operation
  })

  const shutdown: Task<void>[] = []

  for (const task of tasks) {
    shutdown.push(yield* spawn(task.halt))
  }

  for (const task of shutdown) {
    yield* task
  }

  return unwrap(result)
}
