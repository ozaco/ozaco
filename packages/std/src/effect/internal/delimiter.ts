import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { createContext } from '../methods/context'
import { useCoroutine } from './coroutine'
import { withResolvers } from '../methods/with-resolvers'
import {
  fail,
  isFailure,
  isJust,
  just,
  nothing,
  succeed,
  type Maybe,
  type Result,
} from 'std:result'

export class Delimiter<T> implements Operation<Maybe<Result<T, unknown>>>, Helpers.ErrorBoundary {
  level = 0
  finalized = false
  future = withResolvers<Maybe<Result<T, unknown>>>()
  computed = false
  routine?: Helpers.Coroutine
  outcome?: Maybe<Result<T, unknown>>

  constructor(
    public readonly operation: () => Operation<T>,
    public readonly parent?: Delimiter<unknown>,
  ) {}

  raise(error: unknown): void {
    let failure = just(fail(error))
    if (this.finalized) {
      this.parent?.exit(failure)
    } else {
      this.exit(failure)
    }
  }

  interrupt(): void {
    this.exit(nothing())
  }

  *close(): Operation<void> {
    let done = this.future.operation
    let interrupted = !this.computed

    this.close = function* close() {
      let outcome = yield* done
      if (interrupted && isJust(outcome) && isFailure(outcome.value)) {
        throw outcome.value.error
      }
    }
    if (!this.outcome) {
      this.interrupt()
      yield* this.close()
    } else {
      if (interrupted && isJust(this.outcome) && isFailure(this.outcome.value)) {
        throw this.outcome.value.error
      }
    }
  }

  private exit(outcome: Maybe<Result<T, unknown>>): void {
    if (this.finalized) {
      return
    }
    this.outcome = isJust(this.outcome) && isFailure(this.outcome.value) ? this.outcome : outcome
    this.level++
    if (!this.routine) {
      this.finalized = true
      this.future.resolve(this.outcome)
    } else {
      this.routine.return(succeed(this.outcome))
    }
  }

  get validator(): () => boolean {
    let { level } = this
    return () => !this.finalized && this.level === level
  }

  [Symbol.iterator] = function* delimiter(this: Delimiter<T>) {
    this.routine = yield* useCoroutine()

    try {
      let value = yield* this.operation()
      if (this.level === 0) {
        this.computed = true
        this.outcome = just(succeed(value as T) as Result<T, unknown>)
      }
    } catch (error) {
      this.computed = true
      this.outcome = just(fail(error))
    } finally {
      this.finalized = true
      this.outcome = this.outcome ?? nothing()
      this.future.resolve(this.outcome)
      // oxlint-disable-next-line no-unsafe-finally
      return this.outcome
    }
  }
}

export const DelimiterContext = createContext<Delimiter<unknown>>('std:effect:delimiter')

export const ErrorContext = createContext<Helpers.ErrorBoundary>('std:effect:boundary', {
  raise: () => {},
})
