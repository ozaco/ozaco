import type { Operation } from 'std:effect'
import type { StandardSchemaV1 } from 'std:shared'

import type { Request, Response } from 'server:core'

import type { ACTION, ACTION_CONTEXT } from '../const'

export interface ActionConfig<TSchema> {
  input?: TSchema
  output?: StandardSchemaV1

  title?: string
  description?: string
}

export type ActionType = 'http' | 'ws' | 'rpc'

export interface ActionContext<TInput> extends Pick<Request, 'files' | 'meta'> {
  _t: typeof ACTION_CONTEXT

  type: ActionType
  from: string

  body: TInput
  request: Request

  res: Response
}

export interface Action<TArgs extends unknown[] = unknown[], TReturn = unknown, TError = unknown> {
  (...args: TArgs): Operation<TReturn, TError>

  _t: typeof ACTION

  input?: StandardSchemaV1
  output?: StandardSchemaV1

  title?: string
  description?: string
}
