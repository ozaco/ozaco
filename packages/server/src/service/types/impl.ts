import type { Future, Operation } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { ActionContext, ActionMeta } from './action'
import type { Service } from './service'

export namespace Impl {
  export type DefineAction = {
    <Args extends AnyType[], T, E = never>(
      fn: (...args: Args) => Operation<T, E>,
    ): (...args: Args) => Future<T, E>

    <TSchema extends StandardSchemaV1, TReturn, TError>(
      config: ActionMeta<TSchema>,
      handler: (
        ctx: ActionContext<StandardSchemaV1.InferOutput<TSchema>>,
      ) => Operation<TReturn, TError>,
    ): (ctx: {
      body: StandardSchemaV1.InferOutput<TSchema>
    }) => Future<TReturn, TError | 'validation'>
  }

  export type DefineService = <
    TContext,
    TError,
    TArgs extends unknown[] = [],
    TActions = unknown,
  >(options: {
    name: string
    version: string
    description?: string

    actions: TActions

    setup?: (...args: TArgs) => Operation<TContext, TError>
  }) => Service<TContext, TError, TArgs, TActions>
}
