import type { Operation } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { Action } from './action'
import type { Service } from './service'

export namespace Impl {
  export type DefineAction = {
    <TSchema extends StandardSchemaV1, TReturn, TError = never>(
      config: { input: TSchema } & Partial<Omit<Action.Meta<TSchema>, '_t' | 'input'>>,
      handler: (body: StandardSchemaV1.InferOutput<TSchema>) => Operation<TReturn, TError>,
    ): Action<[StandardSchemaV1.InferOutput<TSchema>], TReturn, TError | 'validation'>

    <TReturn, TError = never>(
      config: Partial<Omit<Action.Meta<unknown>, '_t' | 'input'>>,
      handler: (body?: unknown) => Operation<TReturn, TError>,
    ): Action<[body?: unknown], TReturn, TError>

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

    isPrivate?: boolean

    setup?: (...args: TArgs) => Operation<TContext, TError>
  }) => Service<TContext, TError, TArgs, TActions>
}
