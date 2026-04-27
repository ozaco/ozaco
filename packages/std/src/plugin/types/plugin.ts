import type { Context, Operation } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import type { PLUGIN, PROTOCOL } from '../const'

import type { Helpers } from './helpers'

export interface Hookable<TActions extends EmptyType = EmptyType> {
  useHook(): Operation<Map<string, unknown>>
  around(handlers: Helpers.Around<TActions>): Operation<void>
  before(handlers: Helpers.Before<TActions>): Operation<void>
  after(handlers: Helpers.After<TActions>): Operation<void>
  error(handlers: Helpers.OnError<TActions>): Operation<void>
}

export interface Plugin<
  TContext = unknown,
  TError = unknown,
  TArgs extends unknown[] = unknown[],
  TActions = unknown,
> extends Hookable<TActions & EmptyType> {
  _t: typeof PLUGIN
  _st?: symbol | undefined

  name: string
  version: string
  description: string

  setup(...args: TArgs): Operation<TContext, TError>
  context: Context<TContext>

  actions: TActions
  getKeys(): string[]
  getMeta(key: string): Record<string, AnyType> | undefined
}

export interface PluginDef<TContext, TError, TArgs extends unknown[]> {
  context: Context<TContext>

  build(): Plugin<TContext, TError, TArgs>
  build<TActions extends EmptyType>(actions: TActions): Plugin<TContext, TError, TArgs, TActions>
}

export interface Protocol<
  TContext = unknown,
  TError = unknown,
  TArgs extends unknown[] = unknown[],
  TActions extends EmptyType = EmptyType,
  TSelfActions extends EmptyType = EmptyType,
> extends Hookable<TActions> {
  _t: typeof PROTOCOL
  _st?: symbol | undefined
  name: string
  version: string
  context: Context<TContext>
  actions: TActions & TSelfActions

  implement<TIContext extends TContext, TIError extends TError, TIArgs extends TArgs>(options: {
    name: string
    version: string
    description?: string
    setup(...args: TIArgs): Operation<TIContext, TIError>
  }): ImplementedProtocol<TIContext, TIError, TIArgs, TActions>
}

export interface ImplementedProtocol<
  TContext,
  TError,
  TArgs extends unknown[],
  TActions extends EmptyType,
> {
  context: Context<TContext>

  build: <TBuildedActions extends TActions & Record<string | number, AnyType>>(
    actions: TBuildedActions,
  ) => Plugin<TContext, TError, TArgs, TBuildedActions>
}
