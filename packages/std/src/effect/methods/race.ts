import type { Result } from 'std:result'
import { fail, isSuccess, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import { trap } from '../internal/task'
import type { Helpers } from '../types/helpers'
import type { Operation, Task } from '../types/operation'

import { spawn } from './spawn'
import { withResolvers } from './with-resolvers'

export function* race<T extends Operation<unknown, AnyType>>(
  operations: readonly T[],
): Operation<Helpers.Yielded<T>, Helpers.YieldedError<T>> {
  const winner = withResolvers<Result<Helpers.Yielded<T>, unknown>>('await winner')

  const tasks: Task<unknown, unknown>[] = []

  const result = yield* trap(function* () {
    for (const operation of operations.slice()) {
      tasks.push(
        yield* spawn(function* candidate() {
          try {
            const value = yield* operation
            winner.resolve(
              succeed(value as Helpers.Yielded<T>) as Result<Helpers.Yielded<T>, never>,
            )
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
