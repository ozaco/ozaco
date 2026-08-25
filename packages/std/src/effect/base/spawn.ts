import type { Operation, Task } from '../types/operation'

import { useScope } from './hooks'

/**
 * Run another operation concurrently as a child of the current one. The spawned operation begins
 * executing at the next available opportunity and cannot outlive its parent — if the enclosing
 * scope closes before that opportunity arrives, the operation may never start (upstream effection
 * semantics). Use {@link fork} when the child must have started before you continue, and
 * `resource()`/`ensure()` when setup/teardown must be guaranteed.
 */
export function spawn<T>(op: () => Operation<T>): Operation<Task<T>> {
  return {
    *[Symbol.iterator]() {
      const scope = yield* useScope()

      return scope.run(op)
    },
  }
}

/**
 * Like {@link spawn}, but GUARANTEED to have started before it returns: the child has run to its
 * first suspension point, so its `try`/`finally` teardown is armed even if the enclosing scope
 * closes immediately afterwards.
 */
export function fork<T>(op: () => Operation<T>): Operation<Task<T>> {
  return {
    *[Symbol.iterator]() {
      const scope = yield* useScope()

      return yield* scope.fork(op)
    },
  }
}
