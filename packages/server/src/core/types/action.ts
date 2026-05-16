import type { Future, Operation } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { ACTION } from '../const'

export interface Action<
  TArgs extends unknown[] = AnyType[],
  TReturn = AnyType,
  TError = unknown,
> extends Action.Meta<unknown> {
  (...args: TArgs): Operation<TReturn, TError>
}

export namespace Action {
  export interface Meta<TSchema> {
    _t: typeof ACTION

    title?: string
    description?: string

    input?: TSchema
    output?: StandardSchemaV1

    isPrivate: boolean

    allow: AnyType[]
    deny: AnyType[]

    settings: Future<unknown, unknown>[]
  }
}
