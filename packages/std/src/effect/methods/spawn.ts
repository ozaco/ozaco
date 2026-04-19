import type { Operation, Task } from '../types/operation'

import { useScope } from './scope'

export const spawn = <T, E = unknown>(op: () => Operation<T, E>): Operation<Task<T, E>> => ({
  *[Symbol.iterator]() {
    const scope = yield* useScope()
    return scope.run(op)
  },
})
