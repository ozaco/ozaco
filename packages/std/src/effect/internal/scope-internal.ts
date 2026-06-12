import type { Result } from 'std:result'
import { appendCauses, asFailure, fail, isSuccess, succeed, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { SCOPE } from '../const'
import { isSnapshotContext } from '../methods/is'
import { withResolvers } from '../methods/with-resolvers'
import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope, Task } from '../types/operation'

import { Children, Priority } from './contexts'
import { createTask } from './task'

export function createScopeInternal(
  parent?: Scope,
): [Helpers.ScopeInternal, () => Operation<void>] {
  const destructors = new Set<() => Operation<void>>()

  const contexts: Record<string, unknown> = Object.create(
    parent ? (parent as Helpers.ScopeInternal).contexts : null,
  )
  const snapshotKeys = new Set<string>(
    parent ? (parent as Helpers.ScopeInternal).snapshotKeys : undefined,
  )
  const scope: Helpers.ScopeInternal = Object.create({
    _t: SCOPE,
    [Symbol.toStringTag]: 'Scope',
    contexts,
    snapshotKeys,
    get<T>(context: Context<T>): T | undefined {
      return context.name in contexts ? (contexts[context.name] as T) : context.defaultValue
    },
    set<T>(context: Context<T>, value: T): T {
      contexts[context.name] = value
      if (isSnapshotContext(context as Context<unknown>)) {
        snapshotKeys.add(context.name)
      }
      return value
    },
    expect<T>(context: Context<T>): T {
      const value = scope.get(context)
      if (value === undefined) {
        throw fail('missing-context', context.name)
      }
      return value
    },
    delete<T>(context: Context<T>): boolean {
      snapshotKeys.delete(context.name)
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

  if (parent && snapshotKeys.size > 0) {
    const parentContexts = (parent as Helpers.ScopeInternal).contexts
    for (const name of snapshotKeys) {
      if (name in parentContexts) {
        contexts[name] = parentContexts[name]
      }
    }
  }

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
          const failure = asFailure(error)
          outcome = isSuccess(outcome) ? failure : appendCauses(outcome, ...failure.causes)
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
