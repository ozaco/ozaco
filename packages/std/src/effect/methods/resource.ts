import type { Result } from 'std:result'
import { succeed } from 'std:result'

import { Priority } from '../internal/contexts'
import { useCoroutine } from '../internal/coroutine'
import { createTask, trap } from '../internal/task'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { suspend } from './suspend'

export const resource = <T>(
  op: (provide: Helpers.Provide<T>) => Operation<void>,
): Operation<T> => ({
  *[Symbol.iterator]() {
    const caller = yield* useCoroutine()

    function* provide(value: T): Operation<void> {
      caller.next(succeed(value) as Result<T, never>)
      yield* suspend()
    }

    return yield* trap<T>(function* () {
      const { scope, start } = createTask<void>({
        owner: caller.scope as Helpers.ScopeInternal,
        operation: () => op(provide),
      })

      scope.set(Priority, caller.scope.expect(Priority))

      start()

      return (yield {
        enter: () => (uninstalled: Helpers.Resolve<unknown>) => uninstalled(succeed()),
        cause: 'await resource',
      } as Helpers.Effect<T>) as T
    })
  },
})
