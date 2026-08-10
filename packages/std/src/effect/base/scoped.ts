import type { Result } from 'std:result'
import { asFailure, just, succeed } from 'std:result'

import { createScopeInternal } from '../internal/scope-internal'
import { Trap, trap } from '../internal/trap'
import type { Operation } from '../types/operation'

import { critical } from './coroutine'
import { useCoroutine } from './hooks'

/**
 * Run `operation` in a new child scope that is destroyed as soon as the operation completes —
 * a lexical lifetime boundary for resources, without spawning a separate task.
 */
export function scoped<T>(operation: () => Operation<T>): Operation<T> {
  return {
    *[Symbol.iterator]() {
      const routine = yield* useCoroutine()
      const original = routine.scope
      const [scope, destroy] = createScopeInternal(original)
      const boundary = new Trap<T>(routine)
      try {
        routine.scope = scope
        boundary.outcome = just(succeed(yield* trap(operation)) as Result<T>)
      } catch (error) {
        boundary.outcome = just(asFailure(error))
      } finally {
        routine.scope = original
        yield* critical(destroy)
        // oxlint-disable-next-line no-unsafe-finally
        return (yield boundary.exit()) as T
      }
    },
  }
}
