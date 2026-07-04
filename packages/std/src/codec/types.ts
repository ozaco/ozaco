import type { Future, Stream } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

import type { CodecErrors } from './errors'

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

  export type EncodeError = (typeof CodecErrors)['Encode']
  export type DecodeError = (typeof CodecErrors)['Decode']

  export interface Actions {
    encode(value: unknown): Future<Uint8Array, unknown>
    decode<T>(data: Uint8Array): Future<T, unknown>

    /** Like `encode`, but returns the serialized text instead of `Uint8Array` bytes. */
    stringify(value: unknown): Future<string, unknown>
    /** Like `decode`, but takes the serialized text instead of `Uint8Array` bytes. */
    parse<T>(text: string): Future<T, unknown>

    encodeStream<T>(
      stream: Stream<T, unknown>,
    ): Future<Stream<Uint8Array, true | Result.Failure<unknown>>, unknown>
    decodeStream<T>(
      stream: Stream<Uint8Array, unknown>,
      json?: boolean,
    ): Future<Stream<T, true | Result.Failure<unknown>>, unknown>
  }

  export interface Handlers {
    encodeRoot(value: unknown): Future<Uint8Array, unknown>
    decodeRoot<T>(data: Uint8Array): Future<T, unknown>

    encodeStreamRoot<T>(
      stream: Stream<T, unknown>,
    ): Future<Stream<Uint8Array, true | Result.Failure<unknown>>, unknown>
    decodeStreamRoot<T>(
      stream: Stream<Uint8Array, unknown>,
      json?: boolean,
    ): Future<Stream<T, true | Result.Failure<unknown>>, unknown>

    register(transport: CodecDef, entryCtx: CodecDef.Context): Future<void, unknown>
    unregister(transport: CodecDef): Future<void, unknown>
    getTransports(): Future<CodecDef[], unknown>
  }
}
