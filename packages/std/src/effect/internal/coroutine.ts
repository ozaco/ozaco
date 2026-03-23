import { isSuccess, succeed } from 'std:result'
import type { Result } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { Priority } from './contexts'
import { DelimiterContext } from './delimiter'
import { ReducerContext } from './reducer'

export const createCoroutine = <T>({
  operation,
  scope,
}: Helpers.CoroutineOptions<T>): Helpers.Coroutine<T> => {
  const reducer = scope.expect(ReducerContext)

  let iterator: Helpers.Coroutine<T>['data']['iterator'] | undefined = undefined

  const routine = {
    runLevel: 0,
    scope,
    data: {
      get iterator() {
        if (!iterator) {
          iterator = operation()[Symbol.iterator]()
        }
        return iterator
      },
      exit: (resolve: Helpers.Resolve<Result<unknown, unknown>>) => resolve(succeed()),
    },
    next(result: Result<unknown, unknown>) {
      routine.data.exit((exitResult: Result<unknown, unknown>) => {
        routine.data.exit = (didExit: Helpers.Resolve<Result<unknown, unknown>>) =>
          didExit(succeed())
        reducer.reduce([
          scope.expect(Priority),
          routine as unknown as Helpers.Coroutine<unknown>,
          isSuccess(exitResult) ? result : exitResult,
          scope.expect(DelimiterContext).validator,
          'next',
        ])
      })
    },
    return(result: Result<unknown, unknown>) {
      routine.data.exit((exitResult: Result<unknown, unknown>) => {
        routine.data.exit = (didExit: Helpers.Resolve<Result<unknown, unknown>>) =>
          didExit(succeed())
        reducer.reduce([
          scope.expect(Priority),
          routine as unknown as Helpers.Coroutine<unknown>,
          isSuccess(exitResult) ? result : exitResult,
          scope.expect(DelimiterContext).validator,
          'return',
        ])
      })
    },
  } as Helpers.Coroutine<T>

  return routine
}

export function* useCoroutine(): Operation<Helpers.Coroutine> {
  return (yield {
    description: 'useCoroutine()',
    enter: (resolve, routine) => {
      resolve(succeed(routine))
      return uninstalled => uninstalled(succeed())
    },
  } as Helpers.Effect<Helpers.Coroutine>) as Helpers.Coroutine
}
