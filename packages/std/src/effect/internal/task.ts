// oxlint-disable unicorn/no-thenable func-name-matching

import type { Maybe, Result } from 'std:result'
import { asFailure, auto, fail, isFailure, isJust, isSuccess, nothing, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import { critical } from '../base/coroutine'
import { encapsulate, TaskGroupContext } from '../base/task-group'
import type { Helpers } from '../types/helpers'
import type { Future, Task } from '../types/operation'

import { ErrorContext, PriorityContext, SettleContext } from './contexts'
import { createCoroutine } from './coroutine'
import { createScopeInternal } from './scope-internal'
import { trap } from './trap'

const Task = Object.create(Promise.prototype, {
  constructor: { value: function Task() {} },
  [Symbol.toStringTag]: { value: 'Task' },
})

class TaskControl {
  interrupted = false
  settled = false
  constructor(
    public routine: Helpers.Coroutine<unknown>,
    private owner: Helpers.ScopeInternal,
    private detached: boolean,
  ) {}

  interrupt() {
    if (this.settled || this.interrupted) {
      return
    }
    this.interrupted = true
    this.routine.unwind()
  }

  settle(outcome: Maybe<Result<unknown>>, next: (outcome: Maybe<Result<unknown>>) => void): void {
    this.settled = true

    let final: Maybe<Result<unknown>>
    if (isJust(outcome) && isFailure(outcome.value)) {
      final = outcome
    } else if (isJust(outcome) && this.interrupted) {
      final = nothing()
    } else {
      final = outcome
    }

    next(final)

    if (!this.detached && isJust(final) && isFailure(final.value) && !this.interrupted) {
      // SUPERVISED (default) tasks escalate: the failure also crashes the owner scope. Detached
      // tasks deliver it through their future only.
      this.owner.expect(ErrorContext).raise(final.value)
    }
  }
}

class TaskInternal<T> implements Task<T> {
  _promise?: Promise<T>
  scope: Helpers.ScopeInternal
  control: TaskControl
  constructor(
    public routine: Helpers.Coroutine<T>,
    owner: Helpers.ScopeInternal,
    detached: boolean,
  ) {
    this.control = new TaskControl(routine, owner, detached)
    this.scope = this.routine.scope as Helpers.ScopeInternal
    this.scope.set(SettleContext, this.control.settle.bind(this.control))
  }

  then(...args: AnyType[]): Promise<AnyType> {
    return this.promise.then(...args)
  }
  catch(...args: AnyType[]): Promise<AnyType> {
    return this.promise.catch(...args)
  }
  finally(...args: AnyType[]): Promise<AnyType> {
    return this.promise.finally(...args)
  }

  halt(): Future<void> {
    const future = this.routine.future
    const control = this.control

    const signal = () => {
      this.control.interrupt()
      return future
    }
    const halted = async () => {
      const outcome = await signal()

      if (isFailure(outcome)) {
        throw outcome
      }

      if (control.interrupted && isJust(outcome.value) && isFailure(outcome.value.value)) {
        throw outcome.value.value
      }
    }

    return Object.create(future, {
      [Symbol.iterator]: {
        value: function* halt() {
          const outcome = yield* signal()
          if (control.interrupted && isJust(outcome) && isFailure(outcome.value)) {
            throw outcome.value
          }
        },
      },
      then: { value: (...args: AnyType[]) => halted().then(...args) },
      catch: { value: (...args: AnyType[]) => halted().catch(...args) },
      finally: { value: (...args: AnyType[]) => halted().finally(...args) },
    })
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.halt() as unknown as Promise<void>
  }

  *[Symbol.iterator]() {
    const outcome = yield* this.routine.future
    if (isJust(outcome)) {
      const result = outcome.value
      if (isSuccess(result)) {
        return result.value
      }
      throw asFailure(result)
    } else {
      throw fail('halted')
    }
  }

  [Symbol.toStringTag] = 'Task'

  get promise() {
    if (this._promise) {
      return this._promise
    }

    // std contract: the promise side resolves a Result and NEVER rejects — success resolves
    // Success<T>, an operation failure resolves the Failure itself, a halt resolves
    // fail('halted'). (`yield* task` keeps raising, that side is unchanged.)
    this._promise = new Promise(resolve => {
      // oxlint-disable-next-line promise/always-return
      this.routine.future.then(rawOutcome => {
        if (!isSuccess(rawOutcome)) {
          resolve(asFailure(rawOutcome) as T)
          return
        }

        const outcome = rawOutcome.value

        if (isJust(outcome)) {
          const result = outcome.value
          if (isSuccess(result)) {
            // auto() keeps the no-nesting law: a returned bare Failure IS the failure outcome
            resolve(auto(result.value) as T)
          } else {
            resolve(asFailure(result) as T)
          }
        } else {
          resolve(fail('halted') as T)
        }
      })
    })

    return this._promise
  }
}

export function createTask<T>(options: Helpers.TaskOptions<T>): Task<T> {
  const { owner, operation, detached = false } = options
  const [scope, destroy] = createScopeInternal(owner)
  const routine = createCoroutine({
    scope,
    *operation() {
      try {
        return yield* trap(() => encapsulate(operation))
      } finally {
        yield* critical(destroy)
      }
    },
  })

  const internal = new TaskInternal(routine, owner, detached)

  const task = Object.create(Task, {
    halt: { value: () => internal.halt() },
    then: { value: (...args: AnyType[]) => internal.then(...args) },
    catch: { value: (...args: AnyType[]) => internal.catch(...args) },
    finally: { value: (...args: AnyType[]) => internal.finally(...args) },
    [Symbol.asyncDispose]: { value: () => internal[Symbol.asyncDispose]() },
    [Symbol.iterator]: { value: () => internal[Symbol.iterator]() },
    [Symbol.toStringTag]: { value: internal[Symbol.toStringTag] },
  })

  const group = scope.expect(TaskGroupContext)
  group.tasks.add(task)

  const unbind = owner.ensure(task.halt)

  scope.ensure(function* () {
    unbind()
    group.tasks.delete(task)
  })

  if (options.prioritize) {
    scope.set(PriorityContext, owner.get(PriorityContext))
  }

  routine.resume(succeed())

  return task
}
