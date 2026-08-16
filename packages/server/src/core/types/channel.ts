import type { Flow } from 'std:effect'
import type { StandardSchemaV1 } from 'std:shared'

import type { CHANNEL } from '../const'

declare const CHANNEL_VALUE: unique symbol

/** Any Standard Schema validator (zod v4 first-class; anything `~standard` is accepted). */
export type Schema = StandardSchemaV1

export type ChannelKind = 'value' | 'stream' | 'chunks' | 'parts' | 'socket'

/**
 * One wire plane of an action's input or output contract. `schema` present ⇒ codec-encoded values;
 * absent (`chunks`) ⇒ raw bytes. Resolved ONCE at definition time into the action's
 * {@link WireManifest} — carriers route off the manifest and never sniff runtime values.
 */
export interface Channel<T = unknown, K extends ChannelKind = ChannelKind> {
  readonly _t: typeof CHANNEL
  readonly kind: K
  readonly schema?: Schema | undefined
  /** Second direction of a socket channel (server → client emissions). */
  readonly emits?: Schema | undefined
  readonly [CHANNEL_VALUE]?: T
}

/** What `defineAction` accepts for `input` / `output`: a bare schema, a channel, or several. */
export type Declaration = Schema | Channel | readonly Channel[]

/** The resolved, serializable routing contract carriers and policies read. */
export interface WireManifest {
  readonly input: readonly ChannelKind[]
  readonly output: readonly ChannelKind[]
  /** Any non-value input plane (stream/multistream/socket) — bypasses body-only machinery. */
  readonly streamingIn: boolean
  /** Any non-value output plane — streaming dispatch for policy `skipStreaming` decisions. */
  readonly streamingOut: boolean
  /** Output is raw bytes (`chunks`) instead of codec values. */
  readonly bytesOut: boolean
}

/** Infers the handler's `params` type from an input declaration (the `value` plane only). */
export type Params<D> = D extends undefined
  ? undefined
  : D extends Schema
    ? StandardSchemaV1.InferOutput<D>
    : D extends Channel<infer T, infer K>
      ? K extends 'value'
        ? T
        : undefined
      : D extends readonly Channel[]
        ? Extract<D[number], Channel<unknown, 'value'>> extends Channel<infer T, 'value'>
          ? T
          : undefined
        : unknown

/** Infers the handler's return type from an output declaration. */
export type Returns<D> = D extends undefined
  ? unknown
  : D extends Schema
    ? StandardSchemaV1.InferOutput<D>
    : D extends Channel<infer T, infer K>
      ? K extends 'value'
        ? T
        : K extends 'chunks'
          ? Flow<Uint8Array, unknown>
          : K extends 'stream'
            ? Flow<T, unknown>
            : unknown
      : unknown
