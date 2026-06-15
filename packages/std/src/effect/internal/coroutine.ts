import type { Maybe, Result } from 'std:result'
import { asFailure, isFailure, isSuccess, succeed } from 'std:result'
import { lazyPromiseWithResolvers } from 'std:shared'

import { withResolvers } from '../methods/with-resolvers'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { ReducerContext } from './contexts'

// Single shared no-op exit — there is nothing to tear down between most steps, so reuse one closure
// instead of allocating `resolve => resolve(succeed())` on every coroutine and every resume (#1177).
const noopExit: Helpers.Coroutine['data']['exit'] = didExit => didExit(succeed())

export const createCoroutine = <T>({
  operation,
  scope,
}: Helpers.CoroutineOptions<T>): Helpers.Coroutine<T> => {
  const reducer = scope.expect(ReducerContext)

  let iterator: Helpers.Coroutine<T>['data']['iterator'] | undefined = undefined

  // the coroutine future is both awaitable (promise) and yieldable (operation); both sides resolve to
  // the same `Maybe<Result>` outcome when the coroutine settles.
  const settled = withResolvers<Maybe<Result<T, unknown>>>('coroutine')
  const promise = lazyPromiseWithResolvers<Maybe<Result<T, unknown>>>()

  const future = Object.defineProperties(promise.promise, {
    [Symbol.iterator]: {
      enumerable: false,
      value: settled.operation[Symbol.iterator],
    },
    [Symbol.toStringTag]: {
      enumerable: false,
      configurable: true,
      value: 'Future',
    },
  }) as unknown as Helpers.CoroutineFuture<T>

  // guards a single-shot effect resolution: only the resolve belonging to the in-flight effect may
  // resume the coroutine, and only once.
  let resolver: ((result: Result<unknown, unknown>) => void) | null = null

  const routine: Helpers.Coroutine<T> = {
    scope,
    future,
    settle(outcome) {
      resolver = null
      promise.resolve(outcome as Maybe<Result<T, unknown>>)
      settled.resolve(outcome as Maybe<Result<T, unknown>>)
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
    step() {
      const { data } = routine
      const { resumeWith } = data
      const iter = data.iterator

      if (isFailure(resumeWith)) {
        data.unwinding = false
        if (iter.throw) {
          return iter.throw(resumeWith) as IteratorResult<Helpers.Effect<unknown>, T>
        }
        // oxlint-disable-next-line no-throw-literal
        throw resumeWith
      }

      if (data.unwinding && !data.critical) {
        data.unwinding = false
        return (
          iter.return ? iter.return() : { done: true, value: undefined as unknown as T }
        ) as IteratorResult<Helpers.Effect<unknown>, T>
      }

      return iter.next(resumeWith.value) as IteratorResult<Helpers.Effect<unknown>, T>
    },
    perform(effect) {
      const resolve: (result: Result<unknown, unknown>) => void = result => {
        if (resolver === resolve) {
          resolver = null
          routine.resume(result)
        }
      }
      resolver = resolve
      try {
        // #1179 — a throw out of enter() must fail the coroutine, not escape the reducer
        routine.data.exit = effect.enter(resolve, routine)
      } catch (error) {
        routine.resume(asFailure(error))
      }
    },
  }

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

// Mark a region as critical: an `unwind()` requested while inside it is deferred (the region runs to
// completion) instead of early-returning. Used to guarantee teardown (e.g. scope destroy) finishes
// even when the enclosing coroutine is being halted.
export function* critical<T>(operation: () => Operation<T>): Operation<T> {
  const routine = yield* useCoroutine()
  const original = routine.data.critical
  routine.data.critical = true
  try {
    return yield* operation()
  } finally {
    routine.data.critical = original
  }
}
