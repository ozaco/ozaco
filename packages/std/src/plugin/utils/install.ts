import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'

import type { Plugin } from '../types/plugin'

export function* install<TContext, TArgs extends unknown[]>(
  plugin: Plugin<TContext, TArgs>,
  ...args: TArgs
): Operation<TContext> {
  const scope = yield* useScope()

  const value = yield* plugin.setup(...args)

  scope.set(plugin.context, value)

  return value
}
