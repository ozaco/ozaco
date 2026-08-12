import type { Operation, Stream } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

import type { CodecErrors } from './errors'

export type CodecDef = Plugin<CodecDef.Context, unknown[], CodecDef.Actions>

export namespace CodecDef {
  export interface Options {
    name?: string
    priority?: number
  }

  export interface Context {
    name: string
    priority: number
  }

  export type EncodeError = (typeof CodecErrors)['Encode']
  export type DecodeError = (typeof CodecErrors)['Decode']

  export interface Actions {
    encode(value: unknown): Operation<Uint8Array>
    decode<T>(data: Uint8Array): Operation<T>

    /** Like `encode`, but returns the serialized text instead of `Uint8Array` bytes. */
    stringify(value: unknown): Operation<string>
    /** Like `decode`, but takes the serialized text instead of `Uint8Array` bytes. */
    parse<T>(text: string): Operation<T>

    encodeStream<T>(
      stream: Stream<T, unknown>,
    ): Operation<Stream<Uint8Array, true | Result.Failure<unknown>>>
    decodeStream<T>(
      stream: Stream<Uint8Array, unknown>,
      json?: boolean,
    ): Operation<Stream<T, true | Result.Failure<unknown>>>
  }

  export interface JsonActions extends Omit<CodecDef.Actions, 'stringify'> {
    /** Like `encode`, but returns the serialized text instead of `Uint8Array` bytes. */
    stringify(value: unknown, space?: number): Operation<string>
  }

  export interface Handlers {
    register(transport: CodecDef, entryCtx: CodecDef.Context): Operation<void>
    unregister(transport: CodecDef): Operation<void>
    getTransports(): Operation<CodecDef[]>
  }
}
