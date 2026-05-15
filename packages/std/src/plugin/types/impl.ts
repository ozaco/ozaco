import type { Operation } from 'std:effect'
import type { EmptyType } from 'std:shared'

import type { Plugin } from './plugin'
import type { Protocol } from './protocol'

export namespace Impl {
  export type DefinePlugin = <TContext, TError, TArgs extends unknown[] = []>(options: {
    subtype?: symbol | undefined

    name: string
    version: string
    description?: string | undefined

    setup(...args: TArgs): Operation<TContext, TError>
  }) => Plugin.Definition<TContext, TError, TArgs>

  export type DefineProtocol = <
    TContext,
    TError,
    TArgs extends unknown[] = [],
    TActions extends EmptyType = EmptyType,
    TCustomActions extends EmptyType = EmptyType,
  >(options: {
    subtype?: symbol
    cloneable?: boolean

    name: string
    version: string
    description?: string

    handlers?: TCustomActions
    defaultActions?: Partial<TActions>
  }) => Protocol<TContext, TError, TArgs, TActions, TCustomActions>
}
