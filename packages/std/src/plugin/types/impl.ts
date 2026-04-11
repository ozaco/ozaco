import type { Operation } from 'std:effect'

import type { Helpers } from './helpers'
import type { Namespace, Plugin, PluginDef } from './plugin'

export namespace Impl {
  export interface DefinePlugin {
    <
      TContext,
      TError,
      TActions extends Record<string, Helpers.AnyAction> = Record<never, never>,
      TArgs extends unknown[] = [],
    >(options: {
      name: string
      version: string
      description?: string
      namespace: true
    }): Namespace<TContext, TError, TArgs, TActions>

    <TContext, TError, TArgs extends unknown[] = []>(options: {
      name: string
      version: string
      description?: string
      dependencies?: readonly Plugin[]
      setup(...args: TArgs): Operation<TContext, TError>
    }): PluginDef<[TContext, TError], TArgs>
  }
}
