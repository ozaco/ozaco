import type { Operation } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { Action, ActionContext } from './action'
import type { Helpers } from './helpers'
import type { Service } from './service'

export namespace Impl {
  export type DefineAction = {
    <TSchema extends StandardSchemaV1, TReturn, TError = never>(
      config: Omit<Helpers.ActionMeta<TSchema>, '_t' | '_r'>,
      handler: (
        ctx: ActionContext<StandardSchemaV1.InferOutput<TSchema>>,
      ) => Operation<TReturn, TError>,
    ): Action<
      [ctx: { body: StandardSchemaV1.InferOutput<TSchema> }],
      TReturn,
      TError | 'validation'
    >

    <Args extends AnyType[], T, E = never>(
      fn: (...args: Args) => Operation<T, E>,
    ): Action<Args, T, E>
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
