import type { Operation, Stream } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Helpers } from './helpers'

export interface ActionFile {
  name: string
  type: string
  size: number
  lastModified?: number | undefined
  stream: Stream<Uint8Array, AnyType>
}

export interface ActionResponse {
  status: number | null

  meta: Record<string, string> // headers
  files: Record<string, ActionFile[]>
  body: unknown
}

export interface ActionRequest {
  type: 'http' | 'ws' | 'rpc' | 'internal'
  method: string // GET, POST, WS, NATS...
  url: URL

  meta: Record<string, string> // headers
  files: Record<string, ActionFile[]>
  rawBody: Stream<Uint8Array, void> | null
}

export interface Action<
  TArgs extends unknown[] = AnyType[],
  TReturn = AnyType,
  TError = unknown,
> extends Helpers.ActionMeta<unknown> {
  (...args: TArgs): Operation<TReturn, TError>
}
