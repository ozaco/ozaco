import { createTask } from '../internal/task'
import { trap } from '../internal/trap'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { useScope } from './hooks'
import { suspend } from './suspend'
import { withResolvers } from './with-resolvers'

/**
 * Define a value with a lifetime bound to the caller's scope. The body sets the value up, calls
 * `provide(value)` — which suspends until the caller's scope is destroyed — and tears it down in a
 * `finally` block. The resource task runs at the priority of its caller.
 */
export function resource<T>(op: (provide: Helpers.Provide<T>) => Operation<void>): Operation<T> {
  return {
    *[Symbol.iterator]() {
      const ready = withResolvers<T>('resource ready')

      function* provide(value: T): Operation<void> {
        ready.resolve(value)
        yield* suspend()
      }

      const caller = yield* useScope()

      return yield* trap<T>(function* () {
        createTask<void>({
          owner: caller as Helpers.ScopeInternal,
          operation: () => op(provide),
          prioritize: true,
        })

        return yield* ready.operation
      })
    },
  }
}
