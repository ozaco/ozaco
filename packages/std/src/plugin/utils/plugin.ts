import type { AnyType } from 'std:shared'

import { buildPlugin, createProtocolRuntime } from '../internal/runtime'
import type { Impl } from '../types/impl'

/**
 * Define a standalone plugin: an internal single-implementation protocol whose only impl is the
 * plugin itself. Calls on the handle are always pinned to that impl.
 */
export const definePlugin: Impl.DefinePlugin = (options): AnyType => {
  const runtime = createProtocolRuntime({
    name: options.name,
    version: options.version,
    subtype: options.subtype,
  })

  return {
    context: runtime.context,

    build: (actions?: AnyType) => buildPlugin(runtime, options, actions),
  }
}
