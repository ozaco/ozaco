import type { Context, Operation } from 'std:effect'
import { createContext, operation } from 'std:effect'
import { appendCauses, fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { NAMESPACE, PLUGIN } from '../const'
import type { Helpers } from '../types/helpers'
import type { Impl } from '../types/impl'
import type { Plugin } from '../types/plugin'

export const definePlugin: Impl.DefinePlugin = (options: {
  name: string
  version: string
  description?: string
  namespace?: boolean
  dependencies?: readonly Plugin[]
  setup?(...args: AnyType[]): Operation<unknown, unknown>
}): AnyType => {
  const context = createContext(options.name)

  const buildPlugin = (
    opts: {
      name: string
      version: string
      description?: string
      dependencies?: readonly Plugin[]
      setup(...args: AnyType[]): Operation<unknown, unknown>
    },
    actionsCtx?: Context<Record<string, Helpers.AnyAction>>,
  ) => {
    const deps = opts.dependencies ?? []

    return (actions?: Record<string, Helpers.AnyAction>) => {
      const built: Record<string, (...args: unknown[]) => unknown> = {}

      if (actions) {
        for (const key of Object.keys(actions)) {
          const action = actions[key]!
          built[key] = (...args: unknown[]) => ({
            *[Symbol.iterator]() {
              try {
                return yield* action(...args) as Operation<unknown>
              } catch (error) {
                const failure = isFailure(error) ? error : fail(error)

                throw appendCauses(failure, `${opts.name}@${opts.version ?? 'lts'}`)
              }
            },
          })
        }
      }

      let setup = opts.setup
      if (actionsCtx && actions) {
        const rawSetup = opts.setup
        setup = function* (...args: AnyType[]) {
          const value = yield* rawSetup(...args)
          yield* actionsCtx.set(built as AnyType)
          return value
        } as AnyType
      }

      return Object.freeze({
        _t: PLUGIN,
        name: opts.name,
        version: opts.version,
        description: opts.description,
        context,
        dependencies: deps,
        setup: operation(setup as AnyType, '#setup', `${opts.name}@${opts.version ?? 'lts'}`),
        actions: Object.freeze(built),
      })
    }
  }

  if (options.namespace) {
    const actionsCtx = createContext<Record<string, Helpers.AnyAction>>(`${options.name}:actions`)

    return {
      _t: NAMESPACE,
      name: options.name,
      version: options.version,
      context,
      actions: new Proxy(
        {},
        {
          get(_, key: string) {
            return (...args: unknown[]) => ({
              *[Symbol.iterator]() {
                const installed = yield* actionsCtx.expect()
                return yield* (installed as AnyType)[key](...args) as Operation<unknown>
              },
            })
          },
        },
      ),
      implement(implOptions: AnyType) {
        return {
          context,
          build: buildPlugin(implOptions, actionsCtx),
        }
      },
    }
  }

  return {
    context,
    build: buildPlugin(options as AnyType),
  }
}
