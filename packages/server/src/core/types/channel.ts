import type { Stream } from 'std:effect'
import type { Schema } from 'std:shared'

import type { CHANNEL, DataType } from '../const'

/**
 * What ONE side of a call carries, declared rather than discovered.
 *
 * This is the whole point of the type. Every decision the edge and the carriers used to make by
 * inspecting a value at run time — is this a stream, are these bytes, does this need a return
 * channel opened before the answer exists — becomes a lookup on something the author already wrote.
 * Sniffing got it wrong in both directions: a buffered `Uint8Array` was iterated as a stream, and a
 * value feed was served byte by byte.
 *
 * A channel WITHOUT a schema carries raw bytes; one WITH a schema carries values through the codec.
 * That is the entire encoding rule, and it is why there is no separate `encoding` field — a second
 * place to state it is a second place for it to disagree.
 */
export interface Channel<TType extends DataType = DataType, TIn = unknown, TOut = TIn> {
  _t: typeof CHANNEL
  type: TType

  /** absent means raw bytes; present means values validated and encoded through it */
  schema?: Schema

  /** only a socket has a second direction, and only a socket names it */
  emits?: Schema

  /** phantom, so a declaration carries its value type into the handler's signature */
  _in?: TIn
  _out?: TOut
}

export namespace Channel {
  export type Normal<T = unknown> = Channel<typeof DataType.normal, T>
  export type Lane<T = unknown> = Channel<typeof DataType.stream, T>
  export type Lanes<T = unknown> = Channel<typeof DataType.multistream, T>
  export type Socket<TIn = unknown, TOut = unknown> = Channel<typeof DataType.socket, TIn, TOut>

  /**
   * What an author may write in `input` / `output`.
   *
   * A bare schema is sugar for one `normal` value channel, so the everyday
   * `input: z.object({ … })` keeps working untouched and never has to learn this type exists.
   */
  export type Declaration = Schema | Channel | Channel[]

  /**
   * The value the HANDLER receives — the `normal` channel's type, and nothing else.
   *
   * Any other channel an action declares (a byte lane, a socket) is taken inside the body with
   * `useSource`, so adding one never changes the handler's signature.
   */
  export type Body<TDeclaration> = TDeclaration extends undefined
    ? undefined
    : TDeclaration extends Channel<infer TType, infer TValue>
      ? TType extends typeof DataType.normal
        ? TValue
        : undefined
      : TDeclaration extends readonly (infer TItem)[]
        ? BodyOf<TItem>
        : TDeclaration extends Schema
          ? Schema.Infer<TDeclaration>
          : unknown

  type BodyOf<TItem> =
    TItem extends Channel<infer TType, infer TValue>
      ? TType extends typeof DataType.normal
        ? TValue
        : never
      : never

  /** The source a channel produces once the call is running. */
  export type SourceOf<TChannel> =
    TChannel extends Channel<infer TType, infer TIn, infer TOut>
      ? TType extends typeof DataType.normal
        ? TIn
        : TType extends typeof DataType.stream
          ? Stream<TIn, unknown>
          : TType extends typeof DataType.multistream
            ? Record<string, Stream<TIn, unknown>>
            : { inbound: Stream<TIn, unknown>; outbound: { add(value: TOut): void } }
      : never
}
