import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'
import type { EmptyType } from 'std:shared'

import type { Plugin } from '../types/plugin'

/**
 * Install a plugin into the current scope: run its setup, register the implementation in the
 * scope-local install registry, and expose its context value. Children of the scope inherit the
 * installation; siblings don't.
 */
export function* install<TContext, TArgs extends unknown[], TActions extends EmptyType>(
  plugin: Plugin<TContext, TArgs, TActions>,
  ...args: TArgs
): Operation<TContext> {
  const scope = yield* useScope()

  const value = yield* plugin.setup(...args)

  scope.set(plugin.context, value)

  return value
}
