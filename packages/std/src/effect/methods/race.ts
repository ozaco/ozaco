import { fail, isSuccess, succeed } from 'std:result'
import type { Result } from 'std:result'

import { trap } from '../internal/task'
import type { Operation, Task, Yielded } from '../types/operation'

import { spawn } from './spawn'
import { withResolvers } from './with-resolvers'

export function* race<T extends Operation<unknown>>(
  operations: readonly T[],
): Operation<Yielded<T>> {
  const winner = withResolvers<Result<Yielded<T>, unknown>>('await winner')

  const tasks: Task<unknown>[] = []

  const result = yield* trap(function* () {
    for (const operation of operations.slice()) {
      tasks.push(
        yield* spawn(function* candidate() {
          try {
            const value = yield* operation
            winner.resolve(succeed(value as Yielded<T>) as Result<Yielded<T>, never>)
          } catch (error) {
            winner.resolve(fail(error))
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

  if (isSuccess(result)) {
    return result.value
  }
  throw result.error
}
