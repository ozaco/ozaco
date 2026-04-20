import type { Operation } from 'std:effect'
import type { EmptyType } from 'std:shared'

import type { Helpers } from './helpers'
import type { Namespace, PluginDef } from './plugin'

export namespace Impl {
  export type DefinePlugin = <TContext, TError, TArgs extends unknown[] = []>(options: {
    name: string
    version: string
    description?: string
    subtype?: symbol
    setup(...args: TArgs): Operation<TContext, TError>
  }) => PluginDef<TContext, TError, TArgs>

  export type DefineNamespace = <
    TContext,
    TError,
    TArgs extends unknown[] = [],
    TActions extends Record<string, Helpers.AnyAction> = EmptyType,
    TCustomActions extends Record<string, Helpers.AnyAction> = EmptyType,
  >(options: {
    name: string
    version: string
    description?: string
    subtype?: symbol
    handlers?: TCustomActions
    defaultHandlers?: Partial<TActions>
  }) => Namespace<TContext, TError, TArgs, TActions, TCustomActions>
}
