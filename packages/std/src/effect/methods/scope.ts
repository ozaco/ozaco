import { succeed } from 'std:result'

import { createScopeInternal } from '../internal/scope-internal'
import type { Helpers } from '../types/helpers'
import type { Future, Operation, Scope } from '../types/operation'

export const global = createScopeInternal()[0] as Scope

export function createScope(
  parent: Scope = global,
): Scope & AsyncDisposable & [Scope, () => Future<void>] {
  const [scope, destroy] = createScopeInternal(parent)
  const dispose = () => parent.run(destroy)

  const tuple = [scope, dispose]

  Object.defineProperty(scope, Symbol.iterator, {
    value: tuple[Symbol.iterator].bind(tuple),
    enumerable: false,
  })

  Object.defineProperty(scope, Symbol.asyncDispose, {
    enumerable: false,
    value: dispose,
  })

  return scope as unknown as Scope & AsyncDisposable & [Scope, () => Future<void>]
}

export function* useScope(): Operation<Scope> {
  return (yield {
    description: 'useScope()',
    enter(rootResolve, { scope }) {
      rootResolve(succeed(scope))
      return resolve => resolve(succeed())
    },
  } as Helpers.Effect<Scope>) as Scope
}
