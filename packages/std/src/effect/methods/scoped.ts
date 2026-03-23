import type { Operation } from '../types/operation'

import { useCoroutine } from '../internal/coroutine'
import { createScopeInternal } from '../internal/scope-internal'
import { trap } from '../internal/task'

export const scoped = <T>(operation: () => Operation<T>): Operation<T> => ({
  [Symbol.iterator]: function* $scoped() {
    let routine = yield* useCoroutine()
    let original = routine.scope
    let [scope, destroy] = createScopeInternal(original)
    try {
      routine.scope = scope
      return yield* trap(operation)
    } finally {
      routine.scope = original
      yield* destroy()
    }
  },
})
