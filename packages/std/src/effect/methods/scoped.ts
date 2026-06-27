import type { Result } from 'std:result'
import { asFailure, just, succeed } from 'std:result'

import { critical, useCoroutine } from '../internal/coroutine'
import { createScopeInternal } from '../internal/scope-internal'
import { Trap, trap } from '../internal/trap'
import type { Operation } from '../types/operation'

export const scoped = <T, E = never>(operation: () => Operation<T, E>): Operation<T, E> => ({
  [Symbol.iterator]: function* $scoped() {
    const routine = yield* useCoroutine()
    const original = routine.scope

    const [scope, destroy] = createScopeInternal(original)
    const boundary = new Trap<T>(routine)
    try {
      routine.scope = scope
      boundary.outcome = just(succeed(yield* trap(operation)) as Result<T, E>)
    } catch (error) {
      boundary.outcome = just(asFailure(error))
    } finally {
      routine.scope = original
      yield* critical(destroy)
      // oxlint-disable-next-line no-unsafe-finally
      return (yield boundary.exit()) as T
    }
  },
})
