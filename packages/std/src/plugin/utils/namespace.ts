import type { AnyType } from 'std:shared'
import { flatten } from 'std:shared'

import { NAMESPACE } from '../const'
import type { Impl } from '../types/impl'

import { createHookable } from './hooks'

export const defineNamespace: Impl.DefineNamespace = (options: {
  name: string
  version: string
  description?: string
  handlers?: Record<string, AnyType>
  subtype?: symbol
}): AnyType => {
  const { context, actions, hooks, buildPlugin } = createHookable({
    name: options.name,
    version: options.version,
    defaultHandlers: options.handlers ? flatten(options.handlers) : undefined,
    subtype: options.subtype,
  })

  return {
    _t: NAMESPACE,
    name: options.name,
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
