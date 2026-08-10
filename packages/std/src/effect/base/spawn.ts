import type { Operation, Task } from '../types/operation'

import { useScope } from './hooks'

/**
 * Run another operation concurrently as a child of the current one. The spawned operation begins
 * executing at the next available opportunity and cannot outlive its parent.
 */
export function spawn<T>(op: () => Operation<T>): Operation<Task<T>> {
  return {
    *[Symbol.iterator]() {
      const scope = yield* useScope()

      return scope.run(op)
    },
  }
}
