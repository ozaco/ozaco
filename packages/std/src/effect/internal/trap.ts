import type { Result } from 'std:result'
import { asFailure, isJust, isNothing, just, nothing, succeed } from 'std:result'

import { useScope } from '../methods/scope'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { ErrorContext } from './contexts'
import { useCoroutine } from './coroutine'

export function* trap<T, E = never>(operation: () => Operation<T, E>): Operation<T, E> {
  const scope = yield* useScope()
  const original = scope.expect(ErrorContext)
  const routine = yield* useCoroutine()
  const boundary = new Trap<T>(routine)

  scope.set(ErrorContext, boundary)

  try {
    const value = yield* operation()
    if (isNothing(boundary.outcome)) {
      boundary.outcome = just(succeed(value) as Result<T, unknown>)
    }
  } catch (error) {
    boundary.outcome = just(asFailure(error))
  } finally {
    scope.set(ErrorContext, original)
    // oxlint-disable-next-line no-unsafe-finally
    return (yield boundary.exit()) as T
  }
}

export class Trap<T> implements Helpers.ErrorBoundary {
  outcome = nothing<Result<T, unknown>>()

  constructor(public routine: Helpers.Coroutine) {}

  raise(error: unknown): void {
    this.outcome = just(asFailure(error))
    this.routine.unwind()
  }

  exit(): Helpers.Effect<T> {
    return {
      enter: (resolve, routine) => {
        if (isJust(this.outcome)) {
          // resolve with the captured Result — a Failure here re-raises into the trap's caller
          resolve(this.outcome.value)
        } else {
          // nothing captured → this was a halt; keep unwinding instead of returning a value
          routine.unwind()
        }
        return didExit => didExit(succeed())
      },
      cause: 'exit trap',
    }
  }
}
