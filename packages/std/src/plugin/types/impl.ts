import type { Operation } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import type { Plugin } from './plugin'
import type { Protocol } from './protocol'

export namespace Impl {
  export type DefinePlugin = <TContext, TArgs extends unknown[] = []>(options: {
    subtype?: symbol | undefined

    name: string
    version: string
    description?: string | undefined

    setup(...args: TArgs): Operation<TContext>
  }) => Plugin.Definition<TContext, TArgs>

  export type DefineProtocol = <
    TContext = unknown,
    TActions extends EmptyType = EmptyType,
    THandlers extends EmptyType = EmptyType,
  >(options: {
    subtype?: symbol
    /** Allow several implementations to be installed side by side (each with its own context). */
    cloneable?: boolean

    name: string
    version: string
    description?: string

    /** Protocol-level actions: not tied to an installed impl, always run exactly once. */
    handlers?: THandlers
    /** Fallback actions used when the dispatched impl does not provide the key. */
    defaults?: Partial<TActions>

    exec?: Protocol.Exec
  }) => Protocol<TContext, TActions, THandlers>

  export interface RuntimeOptions {
    name: string
    version: string
    subtype?: symbol | undefined
    cloneable?: boolean | undefined
    handlers?: Record<string, AnyType> | undefined
    defaults?: Record<string, AnyType> | undefined
    exec?: Protocol.Exec | undefined
  }
}
