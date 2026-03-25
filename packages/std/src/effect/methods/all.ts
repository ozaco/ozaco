import type { AnyType } from 'std:shared'

import { trap } from '../internal/task'
import type { Helpers } from '../types/helpers'
import type { Operation, Task } from '../types/operation'

import { spawn } from './spawn'

export function* all<T extends readonly Operation<unknown, AnyType>[] | []>(
  ops: T,
): Operation<Helpers.All<T>, Helpers.YieldedError<T[number]>> {
  const tasks: Task<unknown, unknown>[] = []
  try {
    return yield* trap(function* (): Operation<Helpers.All<T>> {
      for (const operation of ops) {
        const member = () => operation
        tasks.push(yield* spawn(member))
      }
      const results: unknown[] = []
      for (const task of tasks) {
        const result = yield* task as AnyType
        results.push(result)
      }
      return results as Helpers.All<T>
    })
  } catch (error) {
    for (const task of tasks) {
      yield* task.halt()
    }
    throw error
  }
}
