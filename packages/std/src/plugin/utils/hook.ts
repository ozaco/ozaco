// oxlint-disable oxc/no-rest-spread-properties

import type { Operation } from 'std:effect'
import { createContext, operation } from 'std:effect'
import { asFailure, fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { PLUGIN } from '../const'
import type { Helpers } from '../types/helpers'

import { createDefaultHooks } from './internal/defaults'
import { intercept } from './internal/intercept'
import { createProxy } from './internal/proxy'
import { wrapAction } from './internal/wrap'

export const createHookable = (options: {
  name: string
  version: string
  handlers?: Record<string, AnyType> | undefined
  defaultActions?: Record<string, AnyType> | undefined
  subtype?: symbol | undefined
}) => {
  const protocolTag = `${options.name}@${options.version ?? 'lts'}`

  const context = createContext(protocolTag)
  const hookCtx = createContext<Helpers.HookStore>(`${protocolTag}#hooks`, createDefaultHooks())
  const chainCtx = createContext<Map<string, unknown>>(`${protocolTag}#chain`)

  const handlers: Record<string, AnyType> = {}
  const defaultActions: Record<string, AnyType> = {}

  if (options.handlers) {
    for (const key of Object.keys(options.handlers)) {
      handlers[key] = wrapAction(options.handlers[key]!, `${key}:handler`, protocolTag)
    }
  }

  if (options.defaultActions) {
    for (const key of Object.keys(options.defaultActions)) {
      defaultActions[key] = wrapAction(options.defaultActions[key]!, `${key}:default`, protocolTag)
    }
  }

  const resolveAction = operation(function* (key: string, ...args: unknown[]) {
    return yield* chainCtx.with(new Map(), function* (): Operation<unknown> {
      const store = (yield* hookCtx.get())!

      const arounds = store.around.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
      const befores = store.before.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
      const afters = store.after.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
      const errors = store.error.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
      const self = handlers[key] ?? store.self[key] ?? (defaultActions as AnyType)[key]

      const inner = function* (...innerArgs: unknown[]) {
        for (const hook of befores) {
          yield* intercept(hook(innerArgs), `${key}:before`)
        }

        if (!self) {
          return yield* fail(
            'unexpected',
            `No handler for "${key}" in "${options.name}", maybe forgot to install "${options.name}" plugin?`,
          )
        }

        let result: unknown = yield* intercept(self(...innerArgs), key)

        for (const hook of afters) {
          const modified = yield* intercept(hook(result, innerArgs), `${key}:after`)
          if (modified !== undefined) {
            result = modified
          }
        }

        return result
      }

      const makeNext =
        (i: number) =>
        (...nextArgs: unknown[]): AnyType => ({
          *[Symbol.iterator]() {
            if (i < arounds.length) {
              return yield* intercept(arounds[i](nextArgs, makeNext(i + 1)))
            }
            return yield* intercept(inner(...nextArgs))
          },
        })

      try {
        if (arounds.length > 0) {
          return yield* intercept(arounds[0](args, makeNext(1)))
        }
        return yield* intercept(inner(...args))
      } catch (error) {
        if (errors.length > 0) {
          for (const hook of errors) {
            yield* intercept(hook(error, args))
          }
        }

        unwrap(asFailure(error))
      }
    })
  }, protocolTag)

  const actions = createProxy('', resolveAction)

  const addHook = (type: 'around' | 'before' | 'after' | 'error') =>
    function* (targetHandlers: Record<string, AnyType>) {
      const store = (yield* hookCtx.get())!
      yield* hookCtx.set({
        ...store,
        [type]: [...store[type], { handlers: flatten(targetHandlers) }],
      })
    }

  const hooks = {
    useHook: () => chainCtx.expect(),
    around: addHook('around'),
    before: addHook('before'),
    after: addHook('after'),
    error: addHook('error'),
  }

  const buildPlugin = (
    buildOptions: {
      name: string
      version: string
      description?: string

      setup(...args: AnyType[]): Operation<unknown, unknown>
    },
    buildActions?: Record<string, Helpers.AnyAction>,
  ) => {
    const pluginTag = `${buildOptions.name}@${buildOptions.version ?? 'lts'}`
    const wrappedActions: Record<string, AnyType> = {}

    if (buildActions) {
      const flatActions = flatten(buildActions)
      for (const key of Object.keys(flatActions)) {
        wrappedActions[key] = wrapAction(flatActions[key]!)
      }
    }

    const setup = function* (...args: AnyType[]) {
      const value = yield* buildOptions.setup(...args)
      const store = (yield* hookCtx.get())!

      yield* hookCtx.set({ ...store, self: { ...store.self, ...wrappedActions } })
      return value
    }

    const knownKeys = [...Object.keys(defaultActions), ...Object.keys(wrappedActions)]

    return Object.freeze({
      _t: PLUGIN,
      _st: options.subtype,

      context,

      name: buildOptions.name,
      version: buildOptions.version,
      description: buildOptions.description,

      useHook: hooks.useHook,
      around: hooks.around,
      before: hooks.before,
      after: hooks.after,
      error: hooks.error,

      actions,
      getKeys: () => knownKeys,
      setup: operation(setup as AnyType, 'setup', pluginTag),
    })
  }

  return { context, actions, hooks, buildPlugin }
}
