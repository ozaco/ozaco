import type { Future, Operation, Stream } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { ACTION, ACTION_CONTEXT } from '../const'

export interface ActionFile {
  name: string
  type: string
  size: number
  lastModified?: number | undefined
  stream: Stream<Uint8Array, AnyType>
}

export interface ActionRequest {
  method: string
  url: URL

  meta: Record<string, string> // headers
  files: Record<string, ActionFile[]>
  body: unknown

  raw: unknown
  rawBody: Stream<Uint8Array, void> | null
}

export interface ActionResponse {
  meta: Record<string, string> // headers
  files: Record<string, ActionFile[]>
  body: unknown

  raw: unknown
}

export interface ActionMeta<TSchema> {
  isRaw?: boolean
  input?: TSchema
  output?: StandardSchemaV1

  title?: string
  description?: string

  allow?: AnyType[]
  deny?: AnyType[]
  settings?: Future<unknown, unknown>[]
}

export interface ActionContext<TInput> extends Pick<ActionRequest, 'files' | 'meta'> {
  _t: typeof ACTION_CONTEXT

  type: 'http' | 'ws' | 'rpc'
  from: string

  body: TInput

  req: ActionRequest
  res: ActionResponse
}

export interface Action<
  TArgs extends unknown[] = AnyType[],
  TReturn = AnyType,
  TError = unknown,
> extends ActionMeta<AnyType> {
  _t: typeof ACTION
  (...args: TArgs): Operation<TReturn, TError>
}
