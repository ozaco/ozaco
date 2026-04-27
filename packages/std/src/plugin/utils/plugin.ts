import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Impl } from '../types/impl'

import { createHookable } from './hook'

export const definePlugin: Impl.DefinePlugin = (options): AnyType => {
  const { context, buildPlugin } = createHookable(options)

  return {
    context,

    build: (buildActions?: Record<string, Helpers.AnyAction>) =>
      buildPlugin(options as AnyType, buildActions),
  }
}
