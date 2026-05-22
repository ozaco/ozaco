import type { Result } from 'std:result'
import { asFailure, fail, isSuccess, succeed, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { SCOPE } from '../const'
import { withResolvers } from '../methods/with-resolvers'
import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope, Task } from '../types/operation'

import { Children, Priority } from './contexts'
import { createTask } from './task'

export function createScopeInternal(
  parent?: Scope,
): [Helpers.ScopeInternal, () => Operation<void>] {
  const destructors = new Set<() => Operation<void>>()
  let parentClose: (() => Operation<void>) | undefined = undefined

  const contexts: Record<string, unknown> = Object.create(
    parent ? (parent as Helpers.ScopeInternal).contexts : null,
  )
  const scope: Helpers.ScopeInternal = Object.create({
    _t: SCOPE,
    [Symbol.toStringTag]: 'Scope',
    contexts,
    get<T>(context: Context<T>): T | undefined {
      return (contexts[context.name] ?? context.defaultValue) as T | undefined
    },
    set<T>(context: Context<T>, value: T): T {
      return (contexts[context.name] = value)
    },
    expect<T>(context: Context<T>): T {
      const value = scope.get(context)
      if (value === undefined) {
        throw fail('missing-context', context.name)
      }
      return value
    },
    delete<T>(context: Context<T>): boolean {
      return Reflect.deleteProperty(contexts, context.name)
    },
    hasOwn<T>(context: Context<T>): boolean {
      return !!Reflect.getOwnPropertyDescriptor(contexts, context.name)
    },
    run<T>(operation: () => Operation<T>): Task<T> {
      const { task, start } = createTask({ operation, owner: scope })
      start()
      return task
    },
    async safeRun<T>(operation: () => Operation<T>): Promise<Result<T, unknown>> {
      const task = scope.run(function* () {
        try {
          return succeed(yield* operation())
        } catch (error) {
          return asFailure(error)
        }
      })

      const result = await task

      return (isSuccess(result) ? result.value : result) as AnyType
    },
    spawn<T>(operation: () => Operation<T>): Operation<Task<T>> {
      return {
        *[Symbol.iterator]() {
          const { task, start } = createTask({ operation, owner: scope })
          start()
          return task
        },
      }
    },
    ensure(op: () => Operation<void>): () => void {
      destructors.add(op)
      return () => destructors.delete(op)
    },
  })

  scope.set(Priority, scope.expect(Priority) + 1)
  scope.set(Children, new Set())
  parent?.expect(Children).add(scope)

  const unbind = parent ? (parent as Helpers.ScopeInternal).ensure(destroy) : () => {}

  let destruction: Helpers.WithResolvers<void> | undefined = undefined

  function* destroy(): Operation<void> {
    if (destruction) {
      return yield* destruction.operation
    }
    destruction = withResolvers<void>()
    parent?.expect(Children).delete(scope)
    unbind()
    let outcome: Result<void, unknown> = succeed()
    try {
      // oxlint-disable-next-line unicorn/no-array-reverse
      for (const destructor of [...destructors].reverse()) {
        try {
          destructors.delete(destructor)
          yield* destructor()
        } catch (error) {
          outcome = asFailure(error)
        }
      }

      if (parentClose) {
        const close = parentClose
        parentClose = undefined
        try {
          yield* close()
        } catch (error) {
          outcome = asFailure(error)
        }
      }
    } finally {
      if (isSuccess(outcome)) {
        destruction.resolve()
      } else {
        destruction.reject(outcome)
      }
    }

    unwrap(outcome)
  }

  return [scope, destroy]
}
