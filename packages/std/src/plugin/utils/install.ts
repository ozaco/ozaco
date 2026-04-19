import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'

import type { Plugin } from '../types/plugin'

export function* install<TContext, TError, TArgs extends unknown[]>(
  plugin: Plugin<TContext, TError, TArgs>,
  ...args: TArgs
): Operation<TContext, TError> {
  const scope = yield* useScope()

  const value = yield* plugin.setup(...args)

  scope.set(plugin.context, value)

  return value
}
