import { isSuccess, succeed } from 'std:result'

import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { DelimiterContext, Priority, ReducerContext } from './contexts'

export const createCoroutine = <T>({
  operation,
  scope,
}: Helpers.CoroutineOptions<T>): Helpers.Coroutine<T> => {
  const reducer = scope.expect(ReducerContext)

  let iterator: Helpers.Coroutine<T>['data']['iterator'] | undefined = undefined

  const routine = {
    scope,
    data: {
      get iterator() {
        if (!iterator) {
          iterator = operation()[Symbol.iterator]()
        }
        return iterator
      },
      exit: resolve => resolve(succeed()),
    },
    next(result) {
      routine.data.exit(exitResult => {
        routine.data.exit = didExit => didExit(succeed())
        reducer.reduce([
          scope.expect(Priority),
          routine,
          isSuccess(exitResult) ? result : exitResult,
          scope.expect(DelimiterContext).validator,
          'next',
        ])
      })
    },
    return(result) {
      routine.data.exit(exitResult => {
        routine.data.exit = didExit => didExit(succeed())
        reducer.reduce([
          scope.expect(Priority),
          routine,
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
    enter: (resolve, routine) => {
      resolve(succeed(routine))
      return uninstalled => uninstalled(succeed())
    },
    cause: 'useCoroutine()',
  } as Helpers.Effect<Helpers.Coroutine>) as Helpers.Coroutine
}
