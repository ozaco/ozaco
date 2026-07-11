import type { Operation, Task } from '../types/operation'

import { useScope } from './scope'

export const spawn = <T>(op: () => Operation<T>): Operation<Task<T>> => ({
  *[Symbol.iterator]() {
    const scope = yield* useScope()
    return scope.run(op)
  },
})
