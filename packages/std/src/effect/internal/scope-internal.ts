import { isSuccess, succeed, unwrap } from 'std:result'

import { SCOPE } from '../const'
import { withResolvers } from '../methods/with-resolvers'
import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope, Task } from '../types/operation'

import { box } from './box'
import { Children, Priority } from './contexts'
import { createTask } from './task'

export function createScopeInternal(
  parent?: Scope,
): [Helpers.ScopeInternal, () => Operation<void>] {
  const destructors = new Set<() => Operation<void>>()

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
        const error = new Error(context.name)
        error.name = 'MissingContextError'
        throw error
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
    spawn<T>(operation: () => Operation<T>): Operation<Task<T>> {
      return {
        // oxlint-disable-next-line require-yield
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
    let outcome = succeed()
    try {
      for (const destructor of destructors) {
        destructors.delete(destructor)
        const result = yield* box(destructor)
        if (!isSuccess(result)) {
          outcome = result
        }
      }
    } finally {
      if (isSuccess(outcome)) {
        destruction.resolve()
      } else {
        destruction.reject(outcome.error)
      }
    }

    unwrap(outcome)
  }

  return [scope, destroy]
}
