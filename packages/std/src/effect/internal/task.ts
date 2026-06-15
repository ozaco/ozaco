import type { Maybe, Result } from 'std:result'
import { fail, isFailure, isJust, isSuccess, nothing, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Future, Operation, Task } from '../types/operation'

import { ErrorContext, Priority, SettleContext, TaskGroupContext } from './contexts'
import { createCoroutine, critical } from './coroutine'
import { createScopeInternal } from './scope-internal'
import { encapsulate } from './task-group'
import { trap } from './trap'

const TaskProto = Object.create(Promise.prototype, {
  [Symbol.toStringTag]: { value: 'Task' },
})

class TaskControl {
  interrupted = false
  settled = false

  constructor(
    public routine: Helpers.Coroutine,
    private owner: Helpers.ScopeInternal,
  ) {}

  interrupt(): void {
    if (this.settled || this.interrupted) {
      return
    }
    this.interrupted = true
    this.routine.unwind()
  }

  settle(
    outcome: Maybe<Result<unknown, unknown>>,
    next: (outcome: Maybe<Result<unknown, unknown>>) => void,
  ): void {
    this.settled = true

    let final: Maybe<Result<unknown, unknown>>
    if (isJust(outcome) && isFailure(outcome.value)) {
      // a real failure always wins, even if we were also interrupted
      final = outcome
    } else if (isJust(outcome) && this.interrupted) {
      // completed/returned but we were halted → represent as halted (Nothing)
      final = nothing()
    } else {
      final = outcome
    }

    next(final)

    if (isJust(final) && isFailure(final.value) && !this.interrupted) {
      // an unhandled failure (we were not halted) escalates to the parent error boundary
      this.owner.expect(ErrorContext).raise(final.value)
    }
  }
}

class TaskInternal<T> {
  scope: Helpers.ScopeInternal
  control: TaskControl
  private _promise?: Promise<Result<T, unknown>>

  constructor(
    public routine: Helpers.Coroutine<T>,
    owner: Helpers.ScopeInternal,
  ) {
    this.control = new TaskControl(routine, owner)
    this.scope = routine.scope as Helpers.ScopeInternal
    this.scope.set(SettleContext, this.control.settle.bind(this.control))
  }

  // std contract: the task's PROMISE side resolves to a `Result` (it never rejects); a halt resolves
  // to a `halted` failure. The OPERATION side (yield* task) returns the value or throws.
  get promise(): Promise<Result<T, unknown>> {
    if (this._promise) {
      return this._promise
    }
    this._promise = new Promise(resolve => {
      // oxlint-disable-next-line promise/always-return
      void this.routine.future.then(outcome => {
        resolve(isJust(outcome) ? (outcome.value as Result<T, unknown>) : fail('halted'))
      })
    })
    return this._promise
  }

  // oxlint-disable-next-line unicorn/no-thenable
  then(...args: AnyType[]): Promise<AnyType> {
    return this.promise.then(...(args as [AnyType]))
  }

  catch(...args: AnyType[]): Promise<AnyType> {
    return this.promise.catch(...(args as [AnyType]))
  }

  finally(...args: AnyType[]): Promise<AnyType> {
    return this.promise.finally(...(args as [AnyType]))
  }

  *[Symbol.iterator](): Generator<Helpers.Effect<unknown> | Result.Failure<unknown>, T, unknown> {
    const outcome = yield* this.routine.future
    if (isJust(outcome)) {
      const result = outcome.value
      if (isSuccess(result)) {
        return result.value as T
      }

      throw result
    }
    throw fail('halted')
  }

  halt(): Future<void> {
    const { future } = this.routine
    const { control } = this

    const signal = () => {
      control.interrupt()
      return future
    }

    const halted = async () => {
      const outcome = await signal()
      if (control.interrupted && isJust(outcome) && isFailure(outcome.value)) {
        throw outcome.value
      }
    }

    return Object.create(future, {
      [Symbol.iterator]: {
        *value() {
          const outcome = yield* signal()
          if (control.interrupted && isJust(outcome) && isFailure(outcome.value)) {
            throw outcome.value
          }
        },
      },
      // oxlint-disable-next-line unicorn/no-thenable
      then: { value: (...args: AnyType[]) => halted().then(...(args as [AnyType])) },
      catch: { value: (...args: AnyType[]) => halted().catch(...(args as [AnyType])) },
      finally: { value: (...args: AnyType[]) => halted().finally(...(args as [AnyType])) },
    }) as Future<void>
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.halt() as unknown as Promise<void>
  }
}

export const createTask = <T>(options: Helpers.TaskOptions<T>): Task<T> => {
  const { owner, operation } = options
  const [scope, destroy] = createScopeInternal(owner)

  const routine = createCoroutine<T>({
    scope,
    *operation() {
      try {
        return yield* trap(() => encapsulate(operation))
      } finally {
        // teardown must complete even while halting, so it runs in a critical region
        yield* critical(destroy)
      }
    },
  })

  const internal = new TaskInternal<T>(routine, owner)

  const task = Object.create(TaskProto, {
    halt: { value: () => internal.halt() },
    // oxlint-disable-next-line unicorn/no-thenable
    then: { value: (...args: AnyType[]) => internal.then(...args) },
    catch: { value: (...args: AnyType[]) => internal.catch(...args) },
    finally: { value: (...args: AnyType[]) => internal.finally(...args) },
    [Symbol.asyncDispose]: { value: () => internal[Symbol.asyncDispose]() },
    [Symbol.iterator]: { value: () => internal[Symbol.iterator]() },
    [Symbol.toStringTag]: { value: 'Task' },
  }) as Task<T>

  const group = scope.expect(TaskGroupContext)
  group.add(task)

  const unbind = owner.ensure(task.halt as () => Operation<void>)

  scope.ensure(function* () {
    unbind()
    group.delete(task)
  })

  if (options.prioritize) {
    scope.set(Priority, owner.expect(Priority))
  }

  routine.resume(succeed())

  return task
}
