import type { Operation } from 'std:effect'

import type { Service } from './service'

export namespace Impl {
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
