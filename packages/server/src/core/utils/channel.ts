import type { Schema } from 'std:shared'

import { CHANNEL, DataType } from '../const'
import type { Channel } from '../types/channel'

const make = (type: DataType, schema?: Schema, emits?: Schema): Channel =>
  ({
    _t: CHANNEL,
    type,
    ...(schema === undefined ? {} : { schema }),
    ...(emits === undefined ? {} : { emits }),
  }) as Channel

/**
 * The five channels an action can declare.
 *
 * A bare schema in `input`/`output` already means {@link value}, so the common case never touches
 * these. Reach for them when a call carries something a JSON Schema cannot describe — and that is
 * exactly the point: `stream`, `parts` and `socket` are not expressible in any schema dialect,
 * which is why the shape has to be DECLARED and cannot be derived from the validator alone.
 *
 * Bytes are always a LANE ({@link chunks} / {@link parts}) — there is no buffered blob channel. A
 * blob read whole cannot cross a wire without holding the body in memory on both sides, so the one
 * shape files travel in is the streaming one.
 */

/** A single validated value. The default, and what the handler receives as its argument. */
export const value = <TSchema extends Schema>(
  schema: TSchema,
): Channel.Normal<Schema.Infer<TSchema>> =>
  make(DataType.normal, schema) as Channel.Normal<Schema.Infer<TSchema>>

/** A feed of validated values — an SSE channel, a live query. */
export const stream = <TSchema extends Schema>(
  schema: TSchema,
): Channel.Lane<Schema.Infer<TSchema>> =>
  make(DataType.stream, schema) as Channel.Lane<Schema.Infer<TSchema>>

/** A feed of raw bytes — an upload, a download. Never reaches the codec. */
export const chunks = (): Channel.Lane<Uint8Array> =>
  make(DataType.stream) as Channel.Lane<Uint8Array>

/** Several named byte lanes at once — a multipart body. */
export const parts = (): Channel.Lanes<Uint8Array> =>
  make(DataType.multistream) as Channel.Lanes<Uint8Array>

/**
 * A duplex connection. Its lifetime is a LEASE, not the dispatch that opened it — which is why it
 * is a channel kind of its own rather than an input paired with an output.
 */
export const socket = <TIn extends Schema, TOut extends Schema>(
  inbound: TIn,
  outbound: TOut,
): Channel.Socket<Schema.Infer<TIn>, Schema.Infer<TOut>> =>
  make(DataType.socket, inbound, outbound) as Channel.Socket<Schema.Infer<TIn>, Schema.Infer<TOut>>
