import type { Context, Operation } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import type { NAMESPACE, PLUGIN } from '../const'

import type { Helpers } from './helpers'

export interface Hookable<TActions extends EmptyType = EmptyType> {
  useHook(): Operation<Map<string, unknown>>
  around(handlers: Helpers.Around<TActions>): Operation<void>
  before(handlers: Helpers.Before<TActions>): Operation<void>
  after(handlers: Helpers.After<TActions>): Operation<void>
  error(handlers: Helpers.OnError<TActions>): Operation<void>
}

export interface Plugin<
  TResult extends [unknown, unknown] = [unknown, unknown],
  TArgs extends unknown[] = unknown[],
  TActions = unknown,
> extends Hookable<TActions & EmptyType> {
  _t: typeof PLUGIN
  name: string
  version: string
  description: string
  context: Context<TResult[0]>
  dependencies: readonly Plugin[]
  setup(...args: TArgs): Operation<TResult[0], TResult[1]>
  actions: TActions
}

export interface PluginDef<TResult extends [unknown, unknown], TArgs extends unknown[]> {
  context: Context<TResult[0]>
  build(): Plugin<TResult, TArgs>
  build<TActions extends EmptyType>(actions: TActions): Plugin<TResult, TArgs, TActions>
}

export interface App {
  install<TResult extends [unknown, unknown], TArgs extends unknown[]>(
    plugin: Plugin<TResult, TArgs>,
    ...args: TArgs
  ): TResult[0]
  use: Helpers.Use
}

export interface Namespace<
  TContext = unknown,
  TError = unknown,
  TArgs extends unknown[] = unknown[],
  TActions extends EmptyType = EmptyType,
> extends Hookable<TActions> {
  _t: typeof NAMESPACE
  name: string
  version: string
  context: Context<TContext>
  actions: TActions
  implement<TImplName extends string>(options: {
    name: TImplName
    version: string
    description?: string
    dependencies?: readonly Plugin[]
    setup(...args: TArgs): Operation<TContext, TError>
  }): NamespaceImpl<[TContext, TError], TArgs, TActions>
}

export interface NamespaceImpl<
  TResult extends [unknown, unknown],
  TArgs extends unknown[],
  TActions extends EmptyType,
> {
  context: Context<TResult[0]>
  build: <TBuildedActions extends TActions & Record<string | number, AnyType>>(
    actions: TBuildedActions,
  ) => Plugin<TResult, TArgs, TBuildedActions>
}
