import { useCoroutine } from '../internal/coroutine'
import { createScopeInternal } from '../internal/scope-internal'
import { trap } from '../internal/task'
import type { Operation } from '../types/operation'

export const scoped = <T>(operation: () => Operation<T>): Operation<T> => ({
  [Symbol.iterator]: function* $scoped() {
    const routine = yield* useCoroutine()
    const original = routine.scope
    const [scope, destroy] = createScopeInternal(original)
    try {
      routine.scope = scope
      return yield* trap(operation)
    } finally {
      routine.scope = original
      yield* destroy()
    }
  },
})
