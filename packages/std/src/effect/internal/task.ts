import type { Helpers } from '../types/helpers'
import type { Operation, Scope, Task } from '../types/operation'

import { createCoroutine } from './coroutine'
import { Delimiter, DelimiterContext, ErrorContext } from './delimiter'
import { createFuture } from './future'
import { createScopeInternal } from './scope-internal'
import { encapsulate, TaskGroupContext } from './task-group'
import { useScope } from '../methods/scope'
import { isJust, isSuccess, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

export interface TaskOptions<T> {
  owner: Helpers.ScopeInternal
  operation(): Operation<T>
}

export interface NewTask<T> {
  scope: Scope
  routine: Helpers.Coroutine
  task: Task<T>
  start(): void
}

export const createTask = <T>(options: TaskOptions<T>): NewTask<T> => {
  let { owner, operation } = options
  let [scope, destroy] = createScopeInternal(owner)
  let future = createFuture<T>()

  let task = Object.defineProperties(future.future, {
    halt: {
      enumerable: false,
      value() {
        // oxlint-disable-next-line no-extend-native
        return Object.defineProperties(Object.create(Promise.prototype), {
          [Symbol.iterator]: {
            enumerable: false,
            value: destroy,
          },
          // oxlint-disable-next-line unicorn/no-thenable
          then: {
            enumerable: false,
            value(...args: Parameters<Promise<void>['then']>) {
              return owner.run(destroy).then(...(args as AnyType))
            },
          },
          catch: {
            enumerable: false,
            value(...args: Parameters<Promise<void>['catch']>) {
              return owner.run(destroy).catch(...args)
            },
          },
          finally: {
            enumerable: false,
            value(...args: Parameters<Promise<void>['finally']>) {
              return owner.run(destroy).finally(...args)
            },
          },
        })
      },
    },
    [Symbol.iterator]: {
      enumerable: false,
      value: future.future[Symbol.iterator],
    },
    [Symbol.toStringTag]: {
      enumerable: false,
      value: 'Task',
    },
    [Symbol.asyncDispose]: {
      enumerable: false,
      value: () => task.halt(),
    },
  }) as Task<T>

  let top = new Delimiter<T>(() => encapsulate(operation))
  scope.set(DelimiterContext, top as Delimiter<unknown>)

  let group = scope.expect(TaskGroupContext)
  group.add(task)

  let boundary = owner.expect(ErrorContext)
  scope.set(ErrorContext, top)

  scope.ensure(function* () {
    try {
      yield* top.close()
    } finally {
      group.delete(task)
      let { outcome } = top
      if (isJust(outcome)) {
        let result = outcome.value
        if (isSuccess(result)) {
          future.resolve(result.value)
        } else {
          let { error } = result
          future.reject(error)
          boundary.raise(error)
        }
      } else {
        let halted = new Error('halted')
        halted.name = 'OperationError'
        future.reject(halted)
      }
    }
  })

  let routine = createCoroutine({
    scope,
    *operation() {
      try {
        yield* top
      } finally {
        yield* destroy()
      }
    },
  })

  let start = () => routine.next(succeed())

  return { scope, routine, task, start }
}

export function* trap<T>(operation: () => Operation<T>): Operation<T> {
  let scope = yield* useScope()

  let original = {
    error: scope.expect(ErrorContext),
    delimiter: scope.expect(DelimiterContext),
  }

  let delimiter = new Delimiter(operation, original.delimiter)

  scope.set(ErrorContext, delimiter)
  scope.set(DelimiterContext, delimiter as Delimiter<unknown>)
  try {
    yield* delimiter
  } finally {
    scope.set(ErrorContext, original.error)
    scope.set(DelimiterContext, original.delimiter)
    let outcome = delimiter.outcome!
    // oxlint-disable-next-line no-unsafe-finally
    return (yield {
      description: 'trap return',
      enter(resolve) {
        if (isJust(outcome)) {
          resolve(outcome.value)
        } else {
          original.delimiter.interrupt()
        }
        return (didExit: Helpers.Resolve<unknown>) => didExit(succeed())
      },
    } as Helpers.Effect<T>) as T
  }
}
