import type { Result } from 'std:result'
import { asFailure, fail, isSuccess, succeed, unwrap } from 'std:result'
import type { EmptyType } from 'std:shared'

import { createFuture } from '../base/future'
import type { Helpers } from '../types/helpers'
import type { Context, Operation, Scope, Task } from '../types/operation'
import { api } from '../utils/api'

import type { ApiInternal } from './api-internal'
import { decorateApi } from './api-internal'
import { ChildrenContext, PriorityContext } from './contexts'
import { createTask } from './task'

export function createScopeInternal(
  parent?: Scope,
): [Helpers.ScopeInternal, () => Operation<void>] {
  if (!parent) {
    const [global, destroy] = buildScopeInternal()
    global.around(
      api.scope,
      {
        // oxlint-disable-next-line no-shadow
        create([parent]) {
          return buildScopeInternal(parent)
        },
      },
      { at: 'min' },
    )
    return [global, destroy] as const
  }
  return api.scope.invoke(parent, 'create', [parent]) as [
    Helpers.ScopeInternal,
    () => Operation<void>,
  ]
}

export function buildScopeInternal(parent?: Scope): [Helpers.ScopeInternal, () => Operation<void>] {
  const destructors = new Set<() => Operation<void>>()
  const destruction = createFuture<void>()
  let signaled = false
  const unbind = parent ? (parent as Helpers.ScopeInternal).ensure(() => destroy()) : () => {}

  const contexts: Record<string, unknown> = Object.create(
    parent ? (parent as Helpers.ScopeInternal).contexts : null,
  )
  const scope: Helpers.ScopeInternal = Object.create({
    [Symbol.toStringTag]: 'Scope',
    contexts,
    get<T>(context: Context<T>): T | undefined {
      return (contexts[context.name] ?? context.defaultValue) as T | undefined
    },
    set<T>(context: Context<T>, value: T): T {
      return api.scope.invoke(scope, 'set', [scope, context, value]) as T
    },
    expect<T>(context: Context<T>): T {
      const value = scope.get(context)
      if (value === undefined) {
        throw fail(`MissingContextError`, context.name)
      }
      return value
    },
    delete<T>(context: Context<T>): boolean {
      return api.scope.invoke(scope, 'delete', [scope, context])
    },
    hasOwn<T>(context: Context<T>): boolean {
      return !!Reflect.getOwnPropertyDescriptor(contexts, context.name)
    },
    run<T>(operation: () => Operation<T>): Task<T> {
      return createTask({ owner: scope, operation })
    },
    spawn<T>(operation: () => Operation<T>): Operation<Task<T>> {
      return {
        *[Symbol.iterator]() {
          return createTask({ owner: scope, operation })
        },
      }
    },
    around<A extends EmptyType>(
      internalApi: ApiInternal<A>,
      ...params: Parameters<ApiInternal<A>['around']>
    ) {
      decorateApi(scope, internalApi, ...params)
    },

    ensure(op: () => Operation<void>): () => void {
      destructors.add(op)
      return () => destructors.delete(op)
    },

    *destroy(): Operation<void> {
      if (signaled) {
        return yield* destruction.future
      }
      signaled = true
      parent?.expect(ChildrenContext).delete(scope)
      unbind()
      let outcome: Result<unknown> = succeed()
      try {
        while (destructors.size > 0) {
          const current = [...destructors]
          destructors.clear()
          for (let i = current.length - 1; i >= 0; i--) {
            const destructor = current[i]!
            try {
              yield* destructor()
            } catch (error) {
              outcome = asFailure(error)
            }
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
    },
  })

  scope.set(PriorityContext, scope.expect(PriorityContext) + 1)
  scope.set(ChildrenContext, new Set())
  parent?.expect(ChildrenContext).add(scope)

  const destroy = () => api.scope.invoke(scope, 'destroy', [scope])

  return [scope, destroy]
}
