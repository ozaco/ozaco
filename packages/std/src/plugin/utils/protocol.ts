import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { PROTOCOL } from '../const'
import type { Impl } from '../types/impl'

import { createHookable } from './hook'

export const defineProtocol: Impl.DefineProtocol = (options): AnyType => {
  const { context, actions, hooks, buildPlugin } = createHookable({
    name: options.name,
    version: options.version,
    handlers: options.handlers ? flatten(options.handlers) : undefined,
    defaultActions: options.defaultActions ? flatten(options.defaultActions) : undefined,
    subtype: options.subtype,
    cloneable: options.cloneable,
  })

  return {
    _t: PROTOCOL,
    _st: options.subtype,

    name: options.name,
    description: options.description,
    version: options.version,

    context,
    actions,

    useHook: hooks.useHook,
    around: hooks.around,
    before: hooks.before,
    after: hooks.after,
    error: hooks.error,

    implement(implOptions: AnyType) {
      return {
        context,
        build: (implActions: AnyType) => buildPlugin(implOptions, implActions),
      }
    },
  }
}
