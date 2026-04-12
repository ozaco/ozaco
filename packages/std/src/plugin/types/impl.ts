import type { Operation } from 'std:effect'

import type { Helpers } from './helpers'
import type { Namespace, Plugin, PluginDef } from './plugin'

export namespace Impl {
  export type DefinePlugin = <TContext, TError, TArgs extends unknown[] = []>(options: {
    name: string
    version: string
    description?: string
    dependencies?: readonly Plugin[]
    setup(...args: TArgs): Operation<TContext, TError>
  }) => PluginDef<[TContext, TError], TArgs>

  export type DefineNamespace = <
    TContext,
    TError,
    TActions extends Record<string, Helpers.AnyAction> = Record<never, never>,
    TArgs extends unknown[] = [],
  >(options: {
    name: string
    version: string
    description?: string
    handlers?: { [K in keyof TActions]: TActions[K] }
  }) => Namespace<TContext, TError, TArgs, TActions>
}
