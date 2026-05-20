import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { CoreErrors } from '../const'

export type CodecDef = Plugin<CodecDef.Context, unknown, unknown[], CodecDef.Actions>

export namespace CodecDef {
  export interface Options {
    name?: string
    priority?: number
  }

  export interface Context {
    name: string
    priority: number
  }

  export type EncodeError = (typeof CoreErrors)['CodecEncode']
  export type DecodeError = (typeof CoreErrors)['CodecDecode']

  export interface Actions {
    encode(value: unknown): Future<Uint8Array, unknown>
    decode(data: Uint8Array): Future<unknown, unknown>
  }

  export interface Handlers {
    encodeRoot(value: unknown): Future<Uint8Array, unknown>
    decodeRoot(data: Uint8Array): Future<unknown, unknown>
  }
}
