import type { Operation } from 'std:effect'
import { createContext } from 'std:effect'
import { appendCauses, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { PLUGIN } from '../const'
import type { AnyAction, Plugin, PluginDef, Use } from '../types'

export const definePlugin = <
  TName extends string,
  TContext,
  TArgs extends unknown[] = [],
>(options: {
  name: TName
  version: string
  description?: string
  dependencies?: readonly Plugin[]
  setup(use: Use, ...args: TArgs): Operation<TContext>
}): PluginDef<TName, TContext, TArgs> => {
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
        setup: options.setup,
        actions: Object.freeze(built),
      }) as Plugin<TName, TContext, TArgs, AnyType>
    },
  }
}
