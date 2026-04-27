import type { Operation, Stream } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { ACTION_CONTEXT } from '../const'

import type { Helpers } from './helpers'

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
  status: number | null

  meta: Record<string, string> // headers
  files: Record<string, ActionFile[]>
  body: unknown

  raw: unknown
}

export interface ActionContext<TInput> extends Pick<ActionRequest, 'files' | 'meta'> {
  _t: typeof ACTION_CONTEXT

  type: 'http' | 'ws' | 'rpc' | 'internal'
  from: string

  body: TInput

  req: ActionRequest
  res: ActionResponse
}

export interface Action<
  TArgs extends unknown[] = AnyType[],
  TReturn = AnyType,
  TError = unknown,
> extends Helpers.ActionMeta<unknown> {
  (...args: TArgs): Operation<TReturn, TError>
}
