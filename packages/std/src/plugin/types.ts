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
  TResult extends [unknown, unknown] = [unknown, unknown],
  TArgs extends unknown[] = unknown[],
  TActions = unknown,
> {
  _t: typeof PLUGIN
  name: TName
  version: string
  description: string
  context: Context<TResult[0]>
  dependencies: readonly Plugin[]
  setup(...args: TArgs): Operation<TResult[0], TResult[1]>
  actions: TActions
}

export interface PluginDef<
  TName extends string,
  TResult extends [unknown, unknown],
  TArgs extends unknown[],
> {
  context: Context<TResult[0]>
  build(): Plugin<TName, TResult, TArgs>
  build<TActions extends Record<string, AnyAction>>(
    actions: TActions,
  ): Plugin<TName, TResult, TArgs, TActions>
}

export interface App {
  install<TName extends string, TResult extends [unknown, unknown], TArgs extends unknown[]>(
    plugin: Plugin<TName, TResult, TArgs>,
    ...args: TArgs
  ): TResult[0]
  use: Use
}

export namespace Helpers {
  export type InferPluginContext<T> = T extends Plugin<string, infer V> ? V[0] : never
  export type InferContext<T> = T extends Context<infer V> ? V : never
}
