import type { Stream } from 'std:effect'

import type { DataType, EXTERNAL_ORIGIN, INTERNAL_ORIGIN } from '../const'

/**
 * What actually ARRIVED on a channel.
 *
 * The run-time counterpart of {@link Channel}: a channel is what an action declared, a source is
 * what a call is carrying. A call holds at most one source per {@link DataType}, which is what makes
 * `useSource(type)` unambiguous — a call either has a socket or it does not, and several byte lanes
 * at once are one `multistream` rather than several `stream`s.
 */
export namespace Source {
  /** Set by whoever admitted the call. A symbol, so nothing on the wire can claim to be internal. */
  export type Origin = typeof INTERNAL_ORIGIN | typeof EXTERNAL_ORIGIN

  export interface Normal<T = unknown> {
    type: typeof DataType.normal
    value: T
  }

  export interface Lane<T = unknown> {
    type: typeof DataType.stream
    stream: Stream<T, unknown>
  }

  /**
   * One part of a multi-lane body: a named byte stream, or a plain field beside it.
   *
   * A discriminated union rather than optional fields, because a consumer branches on exactly this
   * question and `part.stream ?? part.value` is how the wrong half gets read.
   */
  export type Part<T = Uint8Array> =
    | { readonly kind: 'field'; readonly name: string; readonly value: string }
    | {
        readonly kind: 'file'
        readonly name: string
        readonly filename?: string | undefined
        readonly mediaType?: string | undefined
        readonly stream: Stream<T, unknown>
      }

  /**
   * Several lanes on one call — a multipart body.
   *
   * An ORDERED stream of parts, not a record of them, and that is forced by how such a body
   * actually arrives: the parser pauses the upload until the current file has been drained, and
   * that pause IS the backpressure. A record implies every lane is available at once, so the first
   * consumer that skips one deadlocks the parser.
   */
  export interface Lanes<T = Uint8Array> {
    type: typeof DataType.multistream
    parts: Stream<Part<T>, unknown>
  }

  /**
   * A duplex connection.
   *
   * `outbound` is a QUEUE rather than a broadcast primitive, and that is load-bearing: the owning
   * node writes its opening frame before any reader has attached, and a signal drops whatever was
   * sent while nobody was subscribed. A greeting written the instant a socket opens is exactly what
   * went missing.
   */
  export interface Socket<TIn = unknown, TOut = unknown> {
    type: typeof DataType.socket
    inbound: Stream<TIn, unknown>
    outbound: { add(value: TOut): void; close(): void }
  }

  /**
   * `Lanes` is NOT parameterised here: a multipart part is bytes, always. Threading the call's value
   * type through it would make `useSource(multistream)` hand back `Stream<unknown>` and push a cast
   * onto every consumer for a fact the type already knows.
   */
  export type Any<T = unknown> = Normal<T> | Lane<T> | Lanes | Socket<T>

  /** Narrow to the variant a given {@link DataType} produces. */
  export type Of<TType extends DataType, T = unknown> = Extract<Any<T>, { type: TType }>
}

/**
 * What a carrier can read about a channel on the far side.
 *
 * Projected from the declaration and sent WITH the call, so a node holding no definition still
 * knows to open a return lane before the answer exists, and knows whether that lane carries bytes
 * or values. Deriving it on the receiving end would mean deriving it from the payload — which is
 * the sniffing this design exists to remove.
 */
export interface Carried {
  type: DataType
  /** no schema on the channel means these are raw bytes and never touch the codec */
  bytes: boolean
}
