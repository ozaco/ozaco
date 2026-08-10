import { asFailure } from 'std:result'

import { spawn } from '../base/spawn'
import { trap } from '../internal/trap'
import type { Operation, Task } from '../types/operation'
import type { Utils } from '../types/utils'

/**
 * Run every operation concurrently and evaluate to the array of their results, preserving order.
 * If any operation fails, the rest are halted and the failure propagates.
 */
export function* all<T extends readonly Operation<unknown>[] | []>(
  ops: T,
): Operation<Utils.All<T>> {
  const tasks: Task<unknown>[] = []
  try {
    return yield* trap(function* (): Operation<Utils.All<T>> {
      for (const operation of ops) {
        const member = () => operation
        tasks.push(yield* spawn(member))
      }
      const results: unknown[] = []
      for (const task of tasks) {
        results.push(yield* task)
      }
      return results as Utils.All<T>
    })
  } catch (error) {
    for (const task of tasks) {
      yield* task.halt()
    }
    throw asFailure(error)
  }
}
