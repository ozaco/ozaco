import type { Operation } from 'std:effect'
import type { EmptyType } from 'std:shared'

import type { Hookable } from './hookable'
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

    /**
     * Controls how the PROTOCOL-level actions execute across installed impls (default: run the
     * last-installed impl and return its result). `run(entry)` executes the action against one impl
     * (applying its context + hooks) and returns the result; `exec` decides which/how many to run —
     * e.g. the codec protocol runs the highest-priority codec, while a fan-out protocol (logger)
     * runs every transport. Per-plugin proxies (`SomePlugin.actions.*`) ignore this and target
     * their own impl.
     */
    exec?: Hookable.Exec
  }) => Protocol<TContext, TError, TArgs, TActions, TCustomActions>
}
