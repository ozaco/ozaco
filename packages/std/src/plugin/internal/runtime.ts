import type { Context, Operation } from 'std:effect'
import { createApi, createContext, operation } from 'std:effect'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { PluginErrors } from '../errors'
import type { Helpers } from '../types/helpers'
import type { Plugin } from '../types/plugin'
import type { Protocol } from '../types/protocol'

import { PLUGIN, USE } from './const'
import { createHookInstallers } from './hooks'
import { createActionProxy } from './proxy'

const defaultExec: Protocol.Exec = function* (entries, run) {
  return yield* run(entries.at(-1))
}

/**
 * The per-protocol nucleus: a single-member api (`dispatch`) plus the scope-local install
 * registry. Everything else — the flat protocol/plugin handles, hooks, pinning — is built on it.
 */
export const createProtocolRuntime = (options: Helpers.RuntimeOptions) => {
  const tag = `${options.name}@${options.version}`

  /** Holds the dispatched impl's context value while one of its actions runs. */
  const context = createContext<AnyType>(tag)
  const installsCtx = createContext<AnyType[]>(`${tag}#installs`, [])
  /** A plugin handle pins dispatch to its own tag through this context. */
  const targetCtx = createContext<string>(`${tag}#target`)

  const handlers: Record<string, AnyType> = {}
  const defaults: Record<string, AnyType> = {}

  if (options.handlers) {
    const flat = flatten(options.handlers)
    for (const key of Object.keys(flat)) {
      const raw = flat[key]!
      handlers[key] = typeof raw === 'function' ? operation(raw, `${key}:handler`, tag) : raw
    }
  }

  if (options.defaults) {
    const flat = flatten(options.defaults)
    for (const key of Object.keys(flat)) {
      const raw = flat[key]!
      defaults[key] = typeof raw === 'function' ? operation(raw, `${key}:default`, tag) : raw
    }
  }

  const exec = options.exec ?? defaultExec

  const dispatch = operation(
    function* (key: string, args: AnyType[]) {
      const target = yield* targetCtx.get()
      const installs = (yield* installsCtx.get()) ?? []

      // Runs the action against ONE impl entry (or, when `entry` is undefined, a protocol-level
      // handler / default action with no impl context).
      const run = function* (entry: AnyType | undefined): Operation<unknown> {
        // own-property lookups: an action key colliding with an Object.prototype member
        // (toString/valueOf/...) must not resolve to the inherited function
        const self = Object.hasOwn(handlers, key)
          ? handlers[key]
          : entry && Object.hasOwn(entry.actions, key)
            ? entry.actions[key]
            : Object.hasOwn(defaults, key)
              ? defaults[key]
              : undefined

        if (self === undefined) {
          return yield* fail(
            PluginErrors.MissingAction,
            `no handler for "${key}" in "${options.name}", maybe forgot to install a "${options.name}" plugin?`,
          )
        }

        // value members (e.g. `sa: 12`) resolve as-is, mirroring the api layer's value semantics
        if (typeof self !== 'function') {
          return self
        }

        if (entry) {
          return yield* context.with(entry.value, () => self(...args))
        }

        return yield* self(...args)
      }

      // Protocol-level handlers aren't tied to an installed impl and must run exactly once; only
      // impl-provided actions flow through `exec`.
      if (Object.hasOwn(handlers, key)) {
        return yield* run(undefined)
      }

      if (target !== undefined) {
        const entry = installs.find(candidate => candidate.tag === target)
        // clear the pin so protocol calls made INSIDE the action dispatch normally again
        return yield* targetCtx.with(undefined as unknown as string, () => run(entry))
      }

      return yield* exec(installs, run)
    },
    'dispatch',
    tag,
  )

  const api = createApi(`plugin.${tag}`, { dispatch })

  // built on first use: a standalone plugin (`definePlugin`) never exposes them
  let installers: ReturnType<typeof createHookInstallers> | undefined
  const hooks = () => (installers ??= createHookInstallers(api))

  const call = (key: string, args: unknown[]) => api.actions.dispatch(key, args)
  const pinned = (pluginTag: string, key: string, args: unknown[]) =>
    targetCtx.with(pluginTag, () => api.actions.dispatch(key, args))

  return {
    tag,
    context,
    installsCtx,
    handlers,
    defaults,
    api,
    hooks,
    call,
    pinned,
    cloneable: options.cloneable ?? false,
    subtype: options.subtype,
  }
}

export const buildPlugin = ({
  runtime,
  options: buildOptions,
  actions: buildActions,
  context: pluginContext,
}: {
  runtime: ReturnType<typeof createProtocolRuntime>
  options: {
    name: string
    version: string
    description?: string | undefined
    setup(...args: AnyType[]): Operation<unknown>
  }
  actions: Record<string, AnyType> | undefined
  /** the plugin's context — decided by `implement()` / `definePlugin()`, shared with them. */
  context: Context<AnyType>
}): AnyType => {
  const pluginTag = `${buildOptions.name}@${buildOptions.version}`

  const actions: Record<string, AnyType> = {}
  const meta = new Map<string, Record<string, AnyType>>()

  if (buildActions) {
    const flat = flatten(buildActions)
    for (const key of Object.keys(flat)) {
      const raw = flat[key]!
      if (typeof raw === 'function') {
        actions[key] = operation(raw, key, pluginTag)
        meta.set(key, Object.fromEntries(Object.entries(raw)))
      } else {
        // value member: dispatched as-is, `yield* Plugin.key()` resolves to the value
        actions[key] = raw
      }
    }
  }

  const setup = operation(
    function* (...args: AnyType[]) {
      const installs = (yield* runtime.installsCtx.get()) ?? []

      if (!runtime.cloneable) {
        const other = installs.find(entry => entry.tag !== pluginTag)
        if (other) {
          return yield* fail(
            PluginErrors.ProtocolNotCloneable,
            `protocol "${runtime.tag}" is not cloneable; "${other.tag}" already installed, refusing to install "${pluginTag}"`,
          )
        }
      }

      const value = yield* buildOptions.setup(...args)

      const current = (yield* runtime.installsCtx.get()) ?? []
      yield* runtime.installsCtx.set([
        ...current.filter(entry => entry.tag !== pluginTag),
        { tag: pluginTag, value, actions, meta },
      ])

      yield* pluginContext.set(value)

      return value
    },
    'setup',
    pluginTag,
  )

  const handle = {
    _t: PLUGIN,
    _st: runtime.subtype,

    name: buildOptions.name,
    version: buildOptions.version,
    tag: pluginTag,
    description: buildOptions.description,

    context: pluginContext,
    actions: createActionProxy((key, args) => runtime.pinned(pluginTag, key, args)),

    setup,
    // `Plugin.use(...args)`: the install of THIS plugin as an Operation that also names the
    // plugin — what a consumer (`createServer({ plugins })`) takes instead of the handle, so the
    // arguments travel with it. Control surface, not an action: it runs before any dispatch.
    use: (...args: unknown[]): Plugin.Use<unknown, unknown[]> => ({
      _t: USE,
      plugin: handle,
      args,
      *[Symbol.iterator]() {
        // `setup` writes the plugin context into the current scope itself
        return yield* setup(...args)
      },
    }),
    // everything dispatch can resolve — protocol handlers, defaults and the impl's own
    // actions — each name once
    getKeys: () => [
      ...new Set([
        ...Object.keys(runtime.handlers),
        ...Object.keys(runtime.defaults),
        ...Object.keys(actions),
      ]),
    ],
    getMeta: (key: string) => meta.get(key),
  } satisfies Plugin<AnyType, AnyType[]>
  return handle
}
