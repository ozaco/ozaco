import type { Context, Operation } from 'std:effect'
import type { AnyType, EmptyType } from 'std:shared'

import type { PLUGIN } from '../const'

import type { Hookable } from './hookable'

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

export namespace Plugin {
  export type InferContext<T> = T extends Plugin<infer V> ? V : never

  export interface Definition<TContext, TError, TArgs extends unknown[]> {
    context: Context<TContext>

    build(): Plugin<TContext, TError, TArgs>
    build<TActions extends EmptyType>(actions: TActions): Plugin<TContext, TError, TArgs, TActions>
  }
}
