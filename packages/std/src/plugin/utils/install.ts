import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'

import type { Plugin } from '../types/plugin'

export function* install<TResult extends [unknown, unknown], TArgs extends unknown[]>(
  plugin: Plugin<TResult, TArgs>,
  ...args: TArgs
): Operation<TResult[0], TResult[1]> {
  const scope = yield* useScope()

  const value = yield* plugin.setup(...args)

  scope.set(plugin.context, value)

  return value
}
