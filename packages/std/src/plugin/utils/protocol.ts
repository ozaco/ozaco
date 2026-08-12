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

  const base = {
    _t: PROTOCOL,
    _st: options.subtype,

    name: options.name,
    version: options.version,
    tag: runtime.tag,
    description: options.description,

    context: runtime.context,

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
