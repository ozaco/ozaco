import type { Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Helpers } from '../types/helpers'
import type { Impl } from '../types/impl'

import { createHookable } from './hooks'

export const definePlugin: Impl.DefinePlugin = (options: {
  name: string
  version: string
  description?: string
  dependencies?: readonly AnyType[]
  setup(...args: AnyType[]): Operation<unknown, unknown>
}): AnyType => {
  const { context, buildPlugin } = createHookable(options)

  return {
    context,
    build: (buildActions?: Record<string, Helpers.AnyAction>) =>
      buildPlugin(options as AnyType, buildActions),
  }
}
