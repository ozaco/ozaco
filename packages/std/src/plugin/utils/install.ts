import type { Operation } from 'std:effect'
import { useScope } from 'std:effect'

import type { Plugin } from '../types'

export function* install<
  TName extends string,
  TResult extends [unknown, unknown],
  TArgs extends unknown[],
>(plugin: Plugin<TName, TResult, TArgs>, ...args: TArgs): Operation<TResult[0], TResult[1]> {
  const scope = yield* useScope()

  const value = yield* plugin.setup(...args)

  scope.set(plugin.context, value)

  return value
}
