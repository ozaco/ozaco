import type { Operation } from 'std:effect'
import { createContext, operation } from 'std:effect'
import { appendCauses, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { PLUGIN } from '../const'
import type { AnyAction, Plugin, PluginDef } from '../types'

export const definePlugin = <
  TName extends string,
  TContext,
  TError,
  TArgs extends unknown[] = [],
>(options: {
  name: TName
  version: string
  description?: string
  dependencies?: readonly Plugin[]
  setup(...args: TArgs): Operation<TContext, TError>
}): PluginDef<TName, [TContext, TError], TArgs> => {
  const context = createContext<TContext>(options.name)
  const deps = options.dependencies ?? []

  return {
    context,
    build(actions?: Record<string, AnyAction>) {
      const built: Record<string, (...args: unknown[]) => unknown> = {}

      if (actions) {
        for (const key of Object.keys(actions)) {
          const action = actions[key]!
          built[key] = (...args: unknown[]) => ({
            *[Symbol.iterator]() {
              try {
                return yield* action(...args) as Operation<unknown>
              } catch (error) {
                if (isFailure(error)) {
                  throw appendCauses(error, `${options.name}@${options.version ?? 'lts'}`)
                }
                throw error
              }
            },
          })
        }
      }
      return Object.freeze({
        _t: PLUGIN,
        name: options.name,
        version: options.version,
        description: options.description,
        context,
        dependencies: deps,
        setup: operation(
          options.setup as AnyType,
          '#setup',
          `${options.name}@${options.version ?? 'lts'}`,
        ),
        actions: Object.freeze(built),
      }) as Plugin<TName, [TContext, TError], TArgs, AnyType>
    },
  }
}
