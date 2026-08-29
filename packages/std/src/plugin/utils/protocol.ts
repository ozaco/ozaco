import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import { PROTOCOL } from '../const'
import { createActionProxy } from '../internal/proxy'
import { buildPlugin, createProtocolRuntime } from '../internal/runtime'
import type { Impl } from '../types/impl'

export const defineProtocol: Impl.DefineProtocol = (options): AnyType => {
  const runtime = createProtocolRuntime({
    name: options.name,
    version: options.version,
    subtype: options.subtype,
    cloneable: options.cloneable,
    handlers: options.handlers as AnyType,
    defaults: options.defaults as AnyType,
    exec: options.exec,
  })

  /**
   * The dispatched impl's context value while one of its actions runs; outside a dispatch — a
   * plain `useContext(Transport)`, another plugin's `setup` — the ROUTED impl's, i.e. the most
   * recently installed one: whoever a protocol-level action call would reach.
   */
  const routed = function* (): Operation<AnyType> {
    const active = yield* runtime.context.get()
    if (active !== undefined) {
      return active
    }

    const installs = (yield* runtime.installsCtx.get()) ?? []
    return installs.at(-1)?.value
  }

  const base = {
    _t: PROTOCOL,
    _st: options.subtype,

    name: options.name,
    version: options.version,
    tag: runtime.tag,
    description: options.description,

    context: {
      ...runtime.context,
      get: () => routed(),
      *expect() {
        const value = yield* routed()
        // nothing installed and no dispatch: the raw context raises the MissingContextError
        return value === undefined ? yield* runtime.context.expect() : value
      },
    },

    around: runtime.hooks.around,
    before: runtime.hooks.before,
    after: runtime.hooks.after,
    error: runtime.hooks.error,

    implement: (implOptions: AnyType) => ({
      context: runtime.context,
      build: (actions: AnyType) => buildPlugin(runtime, implOptions, actions),
    }),
  }

  return {
    ...base,
    actions: createActionProxy(runtime.call),
  }
}
