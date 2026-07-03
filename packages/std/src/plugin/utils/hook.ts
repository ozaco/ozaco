import type { Operation } from 'std:effect'
import { createContext, operation } from 'std:effect'
import { appendCauses, asFailure, fail, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { PLUGIN, RAW_ACTION } from '../const'
import type { Hookable } from '../types/hookable'

import { createDefaultHooks } from './internal/defaults'
import { intercept } from './internal/intercept'
import { createProxy } from './internal/proxy'

export const createHookable = (options: {
  name: string
  version: string
  handlers?: Record<string, AnyType> | undefined
  defaultActions?: Record<string, AnyType> | undefined
  subtype?: symbol | undefined
  cloneable?: boolean | undefined
}) => {
  const protocolTag = `${options.name}@${options.version ?? 'lts'}`

  const context = createContext(protocolTag)
  const hookCtx = createContext<Hookable.HookStore>(`${protocolTag}#hooks`, createDefaultHooks())
  const chainCtx = createContext<Map<string, unknown>>(`${protocolTag}#chain`)

  const handlers: Record<string, AnyType> = {}
  const defaultActions: Record<string, AnyType> = {}

  if (options.handlers) {
    for (const key of Object.keys(options.handlers)) {
      handlers[key] = operation(options.handlers[key]!, `${key}:handler`, protocolTag)
    }
  }

  if (options.defaultActions) {
    for (const key of Object.keys(options.defaultActions)) {
      defaultActions[key] = operation(options.defaultActions[key]!, `${key}:default`, protocolTag)
    }
  }

  const makeResolveAction = (
    findImpl: (store: Hookable.HookStore) => Hookable.HookSelfEntry | undefined,
    tag: string,
  ) =>
    operation(function* (key: string, ...args: unknown[]) {
      return yield* chainCtx.with(new Map(), function* (): Operation<unknown> {
        const store = (yield* hookCtx.get())!

        const arounds = store.around.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
        const befores = store.before.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
        const afters = store.after.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))
        const errors = store.error.flatMap(e => (key in e.handlers ? [e.handlers[key]] : []))

        const myImpl = findImpl(store)
        const self = handlers[key] ?? myImpl?.handlers[key] ?? (defaultActions as AnyType)[key]

        const inner = function* (...innerArgs: unknown[]) {
          if (innerArgs[0] === RAW_ACTION) {
            return { self, context, options, key, meta: myImpl?.meta?.get(key) }
          }

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

        const runChain = function* (): Operation<unknown> {
          try {
            if (arounds.length > 0) {
              return yield* intercept(arounds[0](args, makeNext(1)))
            }
            return yield* intercept(inner(...args))
          } catch (error) {
            let failure = asFailure(error)

            for (const hook of errors) {
              try {
                yield* intercept(hook(error, args), `${key}:error`)
              } catch (hookError) {
                failure = appendCauses(
                  asFailure(hookError),
                  `masked: ${failure.message || String(failure.error)}`,
                  ...failure.causes,
                )
              }
            }

            unwrap(failure)
          }
        }

        if (myImpl) {
          return yield* context.with(myImpl.contextValue as AnyType, () => runChain())
        }
        return yield* runChain()
      })
    }, tag)

  const actions = createProxy(
    '',
    makeResolveAction(store => store.self.at(-1), protocolTag),
  )

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
    buildActions?: Record<string, Hookable.AnyAction>,
  ) => {
    const pluginTag = `${buildOptions.name}@${buildOptions.version ?? 'lts'}`
    const wrappedActions: Record<string, AnyType> = {}
    const meta = new Map<string, Record<string, AnyType>>()
    const pluginContext = options.cloneable ? createContext(pluginTag) : context

    if (buildActions) {
      const flatActions = flatten(buildActions)
      for (const key of Object.keys(flatActions)) {
        const raw = flatActions[key]!
        wrappedActions[key] = operation(raw)
        meta.set(key, Object.fromEntries(Object.entries(raw)))
      }
    }

    const pluginActions = createProxy(
      '',
      makeResolveAction(store => store.self.find(e => e.tag === pluginTag), pluginTag),
    )

    const setup = function* (...args: AnyType[]) {
      const initial = (yield* hookCtx.get())!

      if (options.cloneable) {
        yield* pluginContext.set(yield* context.get())
      } else {
        const other = initial.self.find(e => e.tag !== pluginTag)
        if (other) {
          return yield* fail(
            'protocol-not-cloneable',
            `protocol "${options.name}" is not cloneable; "${other.tag}" already installed, refusing to install "${pluginTag}"`,
          )
        }
      }

      const value = yield* buildOptions.setup(...args)
      const store = (yield* hookCtx.get())!

      yield* hookCtx.set({
        ...store,
        self: [
          ...store.self.filter(e => e.tag !== pluginTag),
          { tag: pluginTag, handlers: wrappedActions, contextValue: value as AnyType, meta },
        ],
      })

      yield* pluginContext.set(value as AnyType)

      return value
    }

    const knownKeys = [...Object.keys(defaultActions), ...Object.keys(wrappedActions)]

    return Object.freeze({
      _t: PLUGIN,
      _st: options.subtype,

      context: pluginContext,

      name: buildOptions.name,
      version: buildOptions.version,
      description: buildOptions.description,

      useHook: hooks.useHook,
      around: hooks.around,
      before: hooks.before,
      after: hooks.after,
      error: hooks.error,

      actions: pluginActions,
      getKeys: () => knownKeys,
      getMeta: (key: string) => meta.get(key),
      setup: operation(setup as AnyType, 'setup', pluginTag),
    })
  }

  return { context, actions, hooks, buildPlugin }
}
