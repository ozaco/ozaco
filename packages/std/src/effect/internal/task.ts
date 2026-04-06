import { isJust, isSuccess, succeed } from 'std:result'
import type { AnyType } from 'std:shared'

import { useScope } from '../methods/scope'
import type { Helpers } from '../types/helpers'
import type { Operation, Scope, Task } from '../types/operation'

import { DelimiterContext, ErrorContext, TaskGroupContext } from './contexts'
import { createCoroutine } from './coroutine'
import { Delimiter } from './delimiter'
import { createFuture } from './future'
import { createScopeInternal } from './scope-internal'
import { encapsulate } from './task-group'

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
  const { owner, operation } = options
  const [scope, destroy] = createScopeInternal(owner)
  const future = createFuture<T>()

  const task = Object.defineProperties(future.future, {
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

  const top = new Delimiter<T>(() => encapsulate(operation))
  scope.set(DelimiterContext, top as Delimiter<unknown>)

  const group = scope.expect(TaskGroupContext)
  group.add(task)

  const boundary = owner.expect(ErrorContext)
  scope.set(ErrorContext, top)

  scope.ensure(function* () {
    try {
      yield* top.close()
    } finally {
      group.delete(task)
      const { outcome } = top
      if (isJust(outcome)) {
        const result = outcome.value
        if (isSuccess(result)) {
          future.resolve(result.value)
        } else {
          const { error } = result
          future.reject(error)
          boundary.raise(error)
        }
      } else {
        const halted = new Error('halted')
        halted.name = 'OperationError'
        future.reject(halted)
      }
    }
  })

  const routine = createCoroutine({
    scope,
    *operation() {
      try {
        yield* top
      } finally {
        yield* destroy()
      }
    },
  })

  const start = () => routine.next(succeed())

  return { scope, routine, task, start }
}

export function* trap<T>(operation: () => Operation<T>): Operation<T> {
  const scope = yield* useScope()

  const original = {
    error: scope.expect(ErrorContext),
    delimiter: scope.expect(DelimiterContext),
  }

  const delimiter = new Delimiter(operation, original.delimiter)

  scope.set(ErrorContext, delimiter)
  scope.set(DelimiterContext, delimiter as Delimiter<unknown>)
  try {
    yield* delimiter
  } finally {
    scope.set(ErrorContext, original.error)
    scope.set(DelimiterContext, original.delimiter)
    const outcome = delimiter.outcome!
    // oxlint-disable-next-line no-unsafe-finally
    return (yield [
      resolve => {
        if (isJust(outcome)) {
          resolve(outcome.value)
        } else {
          original.delimiter.interrupt()
        }
        return didExit => didExit(succeed())
      },
      'trap return',
    ] as Helpers.Effect<T>) as T
  }
}
