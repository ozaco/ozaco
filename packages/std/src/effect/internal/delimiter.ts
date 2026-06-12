import type { Maybe, Result } from 'std:result'
import { asFailure, isFailure, isJust, just, nothing, succeed } from 'std:result'

import { withResolvers } from '../methods/with-resolvers'
import type { Helpers } from '../types/helpers'
import type { Operation } from '../types/operation'

import { useCoroutine } from './coroutine'

export class Delimiter<T>
  implements Operation<Maybe<Result<T, unknown>>>, Helpers.ErrorBoundary, Helpers.DelimiterLike
{
  state: 'running' | 'cancelling' | 'finalized' = 'running'
  epoch = 0
  computed = false
  future = withResolvers<Maybe<Result<T, unknown>>>()
  routine?: Helpers.Coroutine
  outcome?: Maybe<Result<T, unknown>>

  constructor(
    public readonly operation: () => Operation<T>,
    public readonly parent?: Delimiter<unknown>,
  ) {}

  nextStep(result: Result<unknown, unknown>, epoch: number): Helpers.StepType {
    if (this.epoch !== epoch || this.state === 'finalized') {
      return 'drop'
    }
    if (isFailure(result)) {
      return 'throw'
    }
    if (this.state === 'cancelling') {
      this.state = 'running'
      return 'return'
    }
    return 'next'
  }

  raise(error: unknown): void {
    const failure = just(asFailure(error))
    if (this.state === 'finalized') {
      this.parent?.signal(failure)
    } else {
      this.signal(failure)
    }
  }

  interrupt(): void {
    this.signal(nothing())
  }

  *close(): Operation<void> {
    const done = this.future.operation

    this.close = function* close() {
      const outcome = yield* done
      if (this.epoch > 0 && isJust(outcome) && isFailure(outcome.value)) {
        throw outcome.value
      }
    }
    if (!this.outcome) {
      this.interrupt()
      yield* this.close()
    } else if (this.epoch > 0 && isJust(this.outcome) && isFailure(this.outcome.value)) {
      throw this.outcome.value
    }
  }

  private signal(outcome: Maybe<Result<T, unknown>>): void {
    if (this.state === 'finalized' || this.epoch > 0) {
      return
    }
    this.outcome = outcome
    this.state = 'cancelling'
    this.epoch++
    if (this.routine) {
      this.routine.next(succeed(this.outcome))
    } else {
      this.state = 'finalized'
      this.future.resolve(this.outcome)
    }
  }

  [Symbol.iterator] = function* delimiter(this: Delimiter<T>) {
    try {
      this.routine = yield* useCoroutine()
      const value = yield* this.operation()
      if (this.epoch === 0) {
        this.computed = true
        this.outcome = just(succeed(value as T) as Result<T, unknown>)
      }
    } catch (error) {
      this.computed = true
      this.outcome = just(asFailure(error))
    } finally {
      this.state = 'finalized'
      this.outcome ??= nothing()
      this.future.resolve(this.outcome)
      // oxlint-disable-next-line no-unsafe-finally
      return this.outcome
    }
  }
}
