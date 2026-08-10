import { createScopeInternal } from '../internal/scope-internal'
import type { Future, Scope } from '../types/operation'

/** The root of all effect scopes. */
export const global = createScopeInternal()[0] as Scope

/**
 * Create a new {@link Scope} as a child of `parent`, inheriting all its contexts, along with a
 * function to destroy it. Whenever the scope is destroyed, all tasks and resources it contains are
 * halted. Mostly used by frameworks as an integration point to enter the effect system.
 *
 * Supports both tuple destructuring (`const [scope, destroy] = createScope()`) and explicit
 * resource management (`await using scope = createScope()`).
 */
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
