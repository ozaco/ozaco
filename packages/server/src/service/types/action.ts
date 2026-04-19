import type { Future, Stream } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import type { ACTION_CONTEXT } from '../const'

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
  rawBody: Stream<Uint8Array, void> | null

  raw: unknown
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

export type ActionType = 'http' | 'ws' | 'rpc'

export interface ActionContext<TInput> extends Pick<ActionRequest, 'files' | 'meta'> {
  _t: typeof ACTION_CONTEXT

  type: ActionType
  from: string

  body: TInput
  request: ActionRequest

  res: ActionResponse
}
