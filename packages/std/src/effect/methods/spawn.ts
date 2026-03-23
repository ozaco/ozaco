import type { Operation, Task } from '../types/operation'

import { useScope } from './scope'

export function spawn<T>(op: () => Operation<T>): Operation<Task<T>> {
  return {
    *[Symbol.iterator]() {
      let scope = yield* useScope()
      return scope.run(op)
    },
  }
}
