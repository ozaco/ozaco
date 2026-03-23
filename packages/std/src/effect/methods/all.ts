import type { Helpers } from '../types/helpers'
import type { Operation, Task } from '../types/operation'

import { trap } from '../internal/task'
import { spawn } from './spawn'

export function* all<T extends readonly Operation<unknown>[] | []>(
  ops: T,
): Operation<Helpers.All<T>> {
  let tasks: Task<unknown>[] = []
  try {
    return yield* trap(function* (): Operation<Helpers.All<T>> {
      for (let operation of ops) {
        let member = () => operation
        tasks.push(yield* spawn(member))
      }
      let results: unknown[] = []
      for (let task of tasks) {
        let result = yield* task
        results.push(result)
      }
      return results as Helpers.All<T>
    })
  } catch (error) {
    for (let task of tasks) {
      yield* task.halt()
    }
    throw error
  }
}
