// oxlint-disable unicorn/no-thenable func-name-matching

import type { Maybe, Result } from 'std:result'
import { asFailure, fail, isFailure, isJust, isSuccess, nothing, succeed } from 'std:result'
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

    if (isJust(final) && isFailure(final.value) && !this.interrupted) {
      // raise if there was an error, and we were not halted.
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
  ) {
    this.control = new TaskControl(routine, owner)
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

    this._promise = new Promise((resolve, reject) => {
      // oxlint-disable-next-line promise/always-return
      this.routine.future.then(rawOutcome => {
        let outcome: Maybe<Result<T>> | null = null

        if (isSuccess(rawOutcome)) {
          outcome = rawOutcome.value
        } else {
          return reject(rawOutcome)
        }

        if (isJust(outcome)) {
          const result = outcome.value
          if (isSuccess(result)) {
            resolve(result.value)
          } else {
            resolve(asFailure(result) as T)
          }
        } else {
          reject(fail('halted'))
        }
      })
    })

    return this._promise
  }
}

export function createTask<T>(options: Helpers.TaskOptions<T>): Task<T> {
  const { owner, operation } = options
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

  const internal = new TaskInternal(routine, owner)

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
