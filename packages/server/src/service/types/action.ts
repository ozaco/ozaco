import type { Stream } from 'std:effect'
import type { StandardSchemaV1 } from 'std:shared'

import type { ACTION_CONTEXT } from '../const'

export interface Request {
  method: string
  url: URL

  meta: Record<string, string> // headers
  files: Record<string, Stream<Uint8Array, void>[]>
  body: unknown
  rawBody: Stream<Uint8Array, void>

  raw: unknown
}

export interface Response {
  meta: Record<string, string> // headers
  fils: Record<string, Stream<Uint8Array, void>[]>
  body: unknown

  raw: unknown
}

export interface ActionMeta<TSchema> {
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
