import type { Flow, Operation, Subscription } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

import type { CodecErrors } from './errors'

export type CodecDef = Plugin<CodecDef.Context, unknown[], CodecDef.Actions>

export namespace CodecDef {
  export interface Options {
    name?: string | undefined
    priority?: number | undefined
    /** The file extension (no dot) this codec's documents use — what `std:config` names its
     * files with. Each impl has its own default (`json`, `toml`, `yaml`); pass `yml`, `cfg`, … */
    ext?: string | undefined
  }

  export interface Context {
    name: string
    priority: number
    /** The file extension (no dot) of this codec's documents. */
    ext: string
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

    encodeFlow<T>(
      flow: Flow<T, unknown>,
    ): Operation<Flow<Uint8Array, true | Result.Failure<unknown>>>
    /**
     * Decode a byte flow. `json` is a `JsonCodec`-only switch (default `true`: parse a sequence of
     * JSON values; `false`: emit the decoded text chunks unparsed). `TomlCodec` / `YamlCodec` take
     * no second parameter and ignore it — they buffer the whole source and emit ONE document once
     * it closes. Through `Codec.actions.decodeFlow` the flag therefore only means something while
     * a JSON codec is the active one.
     */
    decodeFlow<T>(
      flow: Flow<Uint8Array, unknown>,
      json?: boolean,
    ): Operation<Flow<T, true | Result.Failure<unknown>>>
  }

  export interface JsonActions extends Omit<CodecDef.Actions, 'stringify'> {
    /** Like `encode`, but returns the serialized text instead of `Uint8Array` bytes. */
    stringify(value: unknown, space?: number): Operation<string>
  }

  /**
   * The registry handlers. Two structures exist side by side and are NOT kept in sync by the
   * protocol: the plugin INSTALL list (what `Codec.actions.encode/decode/…` rank by priority) and
   * this REGISTRY (a scope-local context only `register` writes — what `getTransports` /
   * `hasCodec` read). The shipped impls call `register` from their `setup`, so the two agree; an
   * impl that does not is routable yet invisible here (`hasCodec()` stays `false`).
   *
   * The `transport` wording in the names and parameters is historical — every `transport` here is
   * a CODEC plugin.
   */
  export interface Handlers {
    /**
     * Add a codec to the registry. Entries are keyed by `entryCtx.name` (the user-overridable
     * `Options.name`), not by plugin identity: a name already present fails
     * `CodecErrors.AlreadyRegistered`, while the SAME impl installed twice under two names lands
     * twice — the install list holds it once, so `getTransports()` reports one more entry than
     * there are active installs (both resolve the latest install's context).
     */
    register(transport: CodecDef, entryCtx: CodecDef.Context): Operation<void>
    /** Drop every registry entry whose context name equals `transport`'s CURRENT context name. */
    unregister(transport: CodecDef): Operation<void>
    /** Every codec registered in the current scope chain, ascending by priority — the active one
     * (what `Codec.actions.*` route to) is the LAST entry. */
    getTransports(): Operation<CodecDef[]>
    /** Whether any codec is registered in the CURRENT scope chain — what a plugin asks before
     * installing a default codec of its own. */
    hasCodec(): Operation<boolean>

    /** A wire frame for `data`: strings, `ArrayBuffer`s and views pass through UNTOUCHED, anything
     * else is `stringify`d by `preferred` (else the active codec). `T` is the caller's claim about
     * the frame type — nothing checks it (a passed-through input is returned as is). */
    encodeFrame<T>(data: unknown, preferred?: CodecDef): Operation<T>
    /** The reverse: only a string that looks like JSON (`{` / `[` after trimming) is `parse`d, and
     * a parse failure falls back to the raw string; everything else passes through. `T` is again
     * the caller's unchecked claim. */
    decodeFrame<T>(data: unknown, preferred?: CodecDef): Operation<T>
    /** A subscription over `source` whose every item is `decodeFrame`d on pull — what ws/webrtc
     * hand out as their `messages` Flow (`{ *[Symbol.iterator]() { return yield* decodeFrames(q) } }`). */
    decodeFrames<T, TClose>(
      source: Subscription<unknown, TClose>,
      preferred?: CodecDef,
    ): Operation<Subscription<T, TClose>>
  }
}
