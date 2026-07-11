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

  const shutdown: Task<void>[] = []

  for (const task of tasks) {
    shutdown.push(yield* spawn(task.halt))
  }

  for (const task of shutdown) {
    yield* task
  }

  return unwrap(settled)
}
