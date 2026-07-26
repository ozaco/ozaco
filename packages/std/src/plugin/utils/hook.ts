import type { Operation } from 'std:effect'
import { createContext, operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { PLUGIN } from '../const'
import type { Hookable } from '../types/hookable'

import { createDefaultHooks } from './internal/defaults'
import { intercept } from './internal/intercept'
import { createProxy } from './internal/proxy'
import { pickHooks, runAround, runWithErrorHooks } from './internal/utils'

export const createHookable = (options: {
  name: string
  version: string
  handlers?: Record<string, AnyType> | undefined
  defaultActions?: Record<string, AnyType> | undefined
  subtype?: symbol | undefined
  cloneable?: boolean | undefined
  exec?: Hookable.Exec | undefined
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

  const makeResolveAction = (dispatch: Hookable.Exec, tag: string) =>
    operation(function* (key: string, ...args: unknown[]) {
      return yield* chainCtx.with(new Map(), function* (): Operation<unknown> {
        const store = (yield* hookCtx.get())!

        const call: Hookable.Call = {
          key,
          args,
          arounds: pickHooks(store.around, key),
          befores: pickHooks(store.before, key),
          afters: pickHooks(store.after, key),
          errors: pickHooks(store.error, key),
        }

        // Runs the action against ONE impl entry (or, when `entry` is undefined, a protocol-level
        // handler / default action with no impl context). `dispatch` decides which entries flow
        // through here: the default runs the last-installed impl; the codec runs the highest-priority
        // one; a fan-out protocol (e.g. logger) can run every entry.
        const run = function* (entry: Hookable.HookSelfEntry | undefined): Operation<unknown> {
          // own-property lookups: these are plain objects, so an action key that collides with an
          // Object.prototype member (toString/valueOf/constructor/...) must not resolve to the
          // inherited function
          const self = Object.hasOwn(handlers, key)
            ? handlers[key]
            : entry && Object.hasOwn(entry.handlers, key)
              ? entry.handlers[key]
              : Object.hasOwn(defaultActions, key)
                ? defaultActions[key]
                : undefined

          const inner = function* (...innerArgs: unknown[]) {
            for (const hook of call.befores) {
              yield* intercept(hook(innerArgs), `${key}:before`)
            }

            if (!self) {
              return yield* fail(
                'unexpected',
                `No handler for "${key}" in "${options.name}", maybe forgot to install "${options.name}" plugin?`,
              )
            }

            let result: unknown = yield* intercept(self(...innerArgs), key)

            for (const hook of call.afters) {
              const modified = yield* intercept(hook(result, innerArgs), `${key}:after`)
              if (modified !== undefined) {
                result = modified
              }
            }

            return result
          }

          const chain = () => runWithErrorHooks(call, () => runAround(call, inner))

          if (entry) {
            return yield* context.with(entry.contextValue, chain)
          }
          return yield* chain()
        }

        // Protocol-level handlers (register/getTransports/...) aren't tied to an installed impl and
        // must run exactly once; only impl-provided actions flow through `dispatch`.
        if (Object.hasOwn(handlers, key)) {
          return yield* run(undefined)
        }

        return yield* dispatch(store.self, run)
      })
    }, tag)

  // The protocol proxy runs impl-provided actions via `exec` (default: the last-installed impl). A
  // protocol may override `exec` — the codec protocol runs the highest-priority codec, and a fan-out
  // protocol could run every installed impl. Per-plugin proxies (below, in buildPlugin) always target
  // their own tag and ignore `exec`, so a direct `SomeCodec.actions.decode(...)` still hits that codec.
  const defaultExec: Hookable.Exec = function* (entries, run) {
    return yield* run(entries.at(-1))
  }

  const actions = createProxy('', makeResolveAction(options.exec ?? defaultExec, protocolTag))

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

      setup(...args: AnyType[]): Operation<unknown>
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
      makeResolveAction(function* (entries, run) {
        return yield* run(entries.find(e => e.tag === pluginTag))
      }, pluginTag),
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
