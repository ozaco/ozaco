import type { Context, Operation } from 'std:effect'
import type { EmptyType } from 'std:shared'

import type { PROTOCOL } from '../const'

import type { Hookable } from './hookable'
import type { Plugin } from './plugin'

export interface Protocol<
  TContext = unknown,
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

  implement<TIContext extends TContext, TIArgs extends TArgs>(options: {
    name: string
    version: string
    description?: string
    setup(...args: TIArgs): Operation<TIContext>
  }): Protocol.Implementation<TIContext, TIArgs, TActions>
}

export namespace Protocol {
  export type InferContext<T> = T extends Protocol<infer V> ? V : never

  export interface Implementation<TContext, TArgs extends unknown[], TActions extends EmptyType> {
    context: Context<TContext>

    build: <TBuildedActions extends TActions>(
      actions: TBuildedActions,
    ) => Plugin<TContext, TArgs, TBuildedActions>
  }
}
