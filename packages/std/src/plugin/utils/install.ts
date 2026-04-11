import type { Context, Operation } from 'std:effect'
import { isContext, useScope } from 'std:effect'
import { fail } from 'std:result'

import type { Plugin, Use } from '../types'

import { isPlugin } from './is'

export function* install<TName extends string, TContext, TArgs extends unknown[]>(
  plugin: Plugin<TName, TContext, TArgs>,
  ...args: TArgs
): Operation<TContext> {
  const scope = yield* useScope()

  const use: Use = (target: unknown) => {
    if (isPlugin(target)) {
      return scope.expect(target.context)
    } else if (isContext(target)) {
      return scope.expect(target as Context<unknown>)
    }

    return fail(target, 'use(target: unexpected)')
  }

  const value = yield* plugin.setup(use, ...args)
  scope.set(plugin.context, value)

  return value
}
