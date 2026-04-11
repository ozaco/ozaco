import type { Context, Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { PLUGIN } from './const'

export interface Use {
  <T extends Context<AnyType>>(ctx: T): Helpers.InferContext<T>
  <T extends Plugin>(plugin: T): Helpers.InferPluginContext<T>
}

export type AnyAction = (...args: AnyType[]) => Operation<unknown, unknown>

export interface Plugin<
  TName extends string = string,
  TContext = unknown,
  TArgs extends unknown[] = unknown[],
  TActions = unknown,
> {
  _t: typeof PLUGIN
  name: TName
  version: string
  description: string
  context: Context<TContext>
  dependencies: readonly Plugin[]
  setup(use: Use, ...args: TArgs): Operation<TContext>
  actions: TActions
}

export interface PluginDef<TName extends string, TContext, TArgs extends unknown[]> {
  context: Context<TContext>
  build(): Plugin<TName, TContext, TArgs>
  build<TActions extends Record<string, AnyAction>>(
    actions: TActions,
  ): Plugin<TName, TContext, TArgs, TActions>
}

export namespace Helpers {
  export type InferPluginContext<T> = T extends Plugin<string, infer V> ? V : never
  export type InferContext<T> = T extends Context<infer V> ? V : never
}
