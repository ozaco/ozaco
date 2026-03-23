import { fail, isSuccess, succeed, type Result } from 'std:result'
import type { Operation, Task, Yielded } from '../types/operation'

import { trap } from '../internal/task'
import { spawn } from './spawn'
import { withResolvers } from './with-resolvers'

export function* race<T extends Operation<unknown>>(
  operations: readonly T[],
): Operation<Yielded<T>> {
  let winner = withResolvers<Result<Yielded<T>, unknown>>('await winner')

  let tasks: Task<unknown>[] = []

  let result = yield* trap(function* () {
    for (let operation of operations.slice()) {
      tasks.push(
        yield* spawn(function* candidate() {
          try {
            let value = yield* operation
            winner.resolve(succeed(value as Yielded<T>) as Result<Yielded<T>, never>)
          } catch (error) {
            winner.resolve(fail(error))
          }
        }),
      )
    }
    return yield* winner.operation
  })

  let shutdown: Task<void>[] = []

  for (let task of tasks) {
    shutdown.push(yield* spawn(task.halt))
  }

  for (let task of shutdown) {
    yield* task
  }

  if (isSuccess(result)) {
    return result.value
  }
  throw result.error
}
