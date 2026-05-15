import type { AnyType } from 'std:shared'

import type { Hookable } from '../types/hookable'
import type { Impl } from '../types/impl'

import { createHookable } from './hook'

export const definePlugin: Impl.DefinePlugin = (options): AnyType => {
  const { context, buildPlugin } = createHookable(options)

  return {
    context,

    build: (buildActions?: Record<string, Hookable.AnyAction>) =>
      buildPlugin(options as AnyType, buildActions),
  }
}
