import type { Maybe, Result } from 'std:result'
import { asFailure, isFailure, isSuccess, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import { createFuture } from '../base/future'
import type { Helpers } from '../types/helpers'

import { ReducerContext } from './contexts'

// avoid allocating the same noop exit function on every resume (#1177)
const noopExit: Helpers.Coroutine['data']['exit'] = didExit => didExit(succeed())

export const createCoroutine = <T>({
  operation,
  scope,
}: Helpers.CoroutineOptions<T>): Helpers.Coroutine<T> => {
  const reducer = scope.expect(ReducerContext)

  let iterator:
    | Iterator<Helpers.Effect<unknown> | Result.Failure<AnyType>, T, unknown>
    | undefined = undefined
  const { future, resolve: settle } = createFuture<Maybe<Result<T>>>()

  // oxlint-disable-next-line no-unused-vars
  let resolver: Helpers.Coroutine<T>['resume'] | null = null

  const routine = {
    scope,
    future,
    settle: outcome => {
      resolver = null
      settle(outcome)
    },
    data: {
      get iterator() {
        if (!iterator) {
          iterator = operation()[Symbol.iterator]()
        }
        return iterator
      },
      set iterator(value) {
        iterator = value
      },
      exit: noopExit,
      resumeWith: succeed(),
      enqueued: false,
      critical: false,
      unwinding: false,
    },
    resume(result) {
      resolver = null
      routine.data.exit(exitResult => {
        routine.data.exit = noopExit

        routine.data.resumeWith = isSuccess(exitResult) ? result : exitResult

        reducer.schedule(routine)
      })
    },
    unwind() {
      routine.data.unwinding = true
      if (!routine.data.critical) {
        routine.resume(succeed())
      }
    },
    step(): IteratorResult<Helpers.Effect<unknown> | Result.Failure<AnyType>, T> {
      if (!iterator) {
        iterator = operation()[Symbol.iterator]()
      }

      const data = this.data
      const resumeWith = routine.data.resumeWith

      if (isFailure(resumeWith)) {
        data.unwinding = false
        if (iterator!.throw) {
          return iterator!.throw(resumeWith)
        }

        throw resumeWith
      } else if (data.unwinding && !data.critical) {
        data.unwinding = false
        return iterator!.return
          ? iterator!.return()
          : { done: true, value: undefined as unknown as T }
      }
      return iterator!.next(resumeWith.value)
    },
    perform(effect) {
      const resolve = (resolver = result => {
        if (resolver === resolve) {
          resolver = null
          routine.resume(result)
        }
      })
      try {
        routine.data.exit = effect.enter(resolve, routine)
      } catch (error) {
        routine.resume(asFailure(error))
      }
    },
  } as Helpers.Coroutine<T>

  return routine
}
