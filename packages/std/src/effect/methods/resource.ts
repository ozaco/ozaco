import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { useCoroutine } from '../internal/coroutine'
import { Priority } from '../internal/contexts'
import { createTask, trap } from '../internal/task'
import { suspend } from './suspend'
import { succeed, type Result } from 'std:result'

export interface Provide<T> {
  (value: T): Operation<void>
}

export const resource = <T>(op: (provide: Provide<T>) => Operation<void>): Operation<T> => ({
  *[Symbol.iterator]() {
    let caller = yield* useCoroutine()

    function* provide(value: T): Operation<void> {
      caller.next(succeed(value) as Result<T, never>)
      yield* suspend()
    }

    return yield* trap<T>(function* () {
      let { scope, start } = createTask<void>({
        owner: caller.scope as Helpers.ScopeInternal,
        operation: () => op(provide),
      })

      scope.set(Priority, caller.scope.expect(Priority))

      start()

      return (yield {
        description: 'await resource',
        enter: () => (uninstalled: Helpers.Resolve<unknown>) => uninstalled(succeed()),
      } as Helpers.Effect<T>) as T
    })
  },
})
