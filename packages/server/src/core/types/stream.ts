// oxlint-disable import/exports-last
import type { Flow } from 'std:effect'
import type { StandardSchemaV1 } from 'std:shared'

import type { PARTS_DECL, STREAM_BRAND, STREAM_DECL } from '../const'

/**
 * Branded platform streams: every `ReadableStream` the server hands out or takes in carries a
 * BRAND that says what flows through it — so the edge picks the content type and parser, the
 * carrier picks the wire plane (raw bytes vs codec values), and the client picks the decoder —
 * from the declaration, never by sniffing.
 */
export namespace StreamDef {
  /** `bytes:<mime>` raw bytes; `text` utf-8 text; `json` one codec value as a body; `ndjson` one
   * codec value per line; `sse` server-sent events; user brands via `stream.brand(...)`. */
  export type Brand = string

  export type Branded<B extends Brand = Brand, T = Uint8Array> = ReadableStream<T> & {
    readonly [STREAM_BRAND]: B
  }

  /** How a brand travels and renders. */
  export interface BrandSpec {
    /** the HTTP content type when the stream is a body. */
    readonly contentType: string

    /** `stream` = raw bytes over the carrier's byte lane; `flow` = codec values over a value
     * lane (one value per chunk). */
    readonly plane: 'stream' | 'flow'

    /** how a client decodes it. */
    readonly client: 'blob' | 'text' | 'json' | 'iterator' | 'events'

    /** value schema for `flow` brands (one chunk = one value). */
    readonly schema?: StandardSchemaV1 | undefined
  }

  /** A stream declaration on an action's input/output (definition time). */
  export interface Decl<B extends Brand = Brand, T = unknown> {
    readonly _t: typeof STREAM_DECL
    readonly brand: B
    readonly spec: BrandSpec
    readonly [STREAM_VALUE]?: T
  }

  /** A multipart declaration: named fields (codec values) and named streams (files). */
  export interface PartsDecl<TFields = unknown, TStreams extends string = string> {
    readonly _t: typeof PARTS_DECL
    readonly fields: StandardSchemaV1 | null
    readonly streams: Readonly<Record<TStreams, Decl>>
    readonly [PARTS_VALUE]?: TFields
  }

  /** What a `parts` input resolves to inside the handler. */
  export type Parts<TFields, TStreams extends string> = {
    readonly fields: TFields
    readonly streams: Readonly<Record<TStreams, Branded<Brand, Uint8Array>>>
  }

  /** A Flow as a branded stream source: what `stream.of(flow, brand)` consumes. */
  export type Source<T> = Flow<T, unknown>
}

declare const STREAM_VALUE: unique symbol
declare const PARTS_VALUE: unique symbol
