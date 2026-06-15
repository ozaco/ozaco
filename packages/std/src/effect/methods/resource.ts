import type { AnyType } from 'std:shared'

import { createTask } from '../internal/task'
import { trap } from '../internal/trap'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { useScope } from './scope'
import { suspend } from './suspend'
import { withResolvers } from './with-resolvers'

export const resource = <T, E = never>(
  op: (provide: Helpers.Provide<T>) => Operation<void, E>,
): Operation<T, E> => ({
  *[Symbol.iterator]() {
    const ready = withResolvers<T>('await resource')

    function* provide(value: T): Operation<void> {
      ready.resolve(value)
      yield* suspend()
    }

    const caller = yield* useScope()

    // a control boundary lets us surface an error thrown by the resource initializer to the caller
    return yield* trap<T>(function* () {
      // the resource lifecycle runs as a child task of the caller's scope, prioritized so it settles
      // in step with the caller; it stays suspended at provide() until the caller's scope tears down
      createTask<void>({
        owner: caller as Helpers.ScopeInternal,
        operation: () => op(provide) as Operation<AnyType>,
        prioritize: true,
      })

      return yield* ready.operation
    })
  },
})
