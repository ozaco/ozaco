import type { Future, Stream } from 'std:effect'
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
    encode(value: unknown): Future<Uint8Array>
    decode<T>(data: Uint8Array): Future<T>

    /** Like `encode`, but returns the serialized text instead of `Uint8Array` bytes. */
    stringify(value: unknown): Future<string>
    /** Like `decode`, but takes the serialized text instead of `Uint8Array` bytes. */
    parse<T>(text: string): Future<T>

    encodeStream<T>(
      stream: Stream<T, unknown>,
    ): Future<Stream<Uint8Array, true | Result.Failure<unknown>>>
    decodeStream<T>(
      stream: Stream<Uint8Array, unknown>,
      json?: boolean,
    ): Future<Stream<T, true | Result.Failure<unknown>>>
  }

  export interface Handlers {
    encodeRoot(value: unknown): Future<Uint8Array>
    decodeRoot<T>(data: Uint8Array): Future<T>

    encodeStreamRoot<T>(
      stream: Stream<T, unknown>,
    ): Future<Stream<Uint8Array, true | Result.Failure<unknown>>>
    decodeStreamRoot<T>(
      stream: Stream<Uint8Array, unknown>,
      json?: boolean,
    ): Future<Stream<T, true | Result.Failure<unknown>>>

    register(transport: CodecDef, entryCtx: CodecDef.Context): Future<void>
    unregister(transport: CodecDef): Future<void>
    getTransports(): Future<CodecDef[]>
  }
}
