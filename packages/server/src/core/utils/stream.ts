// oxlint-disable import/exports-last
import type { Flow, Operation } from 'std:effect'
import { fromReadable, toReadable } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'

import { PARTS_DECL, STREAM_BRAND, STREAM_DECL } from '../const'
import type { StreamDef } from '../types/stream'

/** The brands core knows out of the box; `stream.brand(...)` registers more. */
const registry = new Map<string, StreamDef.BrandSpec>()

const register = (brand: string, spec: StreamDef.BrandSpec): StreamDef.BrandSpec => {
  registry.set(brand, spec)
  return spec
}

/** The spec of a brand, or null when unknown. `bytes:<mime>` resolves for any mime. */
export const brandSpecOf = (brand: string): StreamDef.BrandSpec | null => {
  const known = registry.get(brand)

  if (known) {
    return known
  }

  if (brand.startsWith('bytes:')) {
    return register(brand, { contentType: brand.slice(6), plane: 'stream', client: 'blob' })
  }

  return null
}

const decl = <B extends string, T>(brand: B, spec: StreamDef.BrandSpec): StreamDef.Decl<B, T> => ({
  _t: STREAM_DECL,
  brand,
  spec: register(brand, spec),
})

/** Stamp a platform stream with a brand. */
export const brandStream = <B extends string, T>(
  readable: ReadableStream<T>,
  brand: B,
): StreamDef.Branded<B, T> =>
  Object.defineProperty(readable, STREAM_BRAND, { value: brand, enumerable: false }) as AnyType

export const isBranded = (value: unknown): value is StreamDef.Branded =>
  value instanceof ReadableStream && STREAM_BRAND in value

export const brandOf = (value: StreamDef.Branded): string => value[STREAM_BRAND]

export const isStreamDecl = (value: unknown): value is StreamDef.Decl =>
  typeof value === 'object' && value !== null && (value as StreamDef.Decl)._t === STREAM_DECL

export const isPartsDecl = (value: unknown): value is StreamDef.PartsDecl =>
  typeof value === 'object' && value !== null && (value as StreamDef.PartsDecl)._t === PARTS_DECL

/**
 * Stream declarations and constructors. Declarations go on `action({ input, output })`;
 * constructors turn Flows and platform streams into BRANDED streams the edge, the carriers and
 * the client all understand without sniffing.
 */
export const stream = {
  /** raw bytes with a content type (`image/png`, `application/octet-stream`, …). */
  bytes: (mime = 'application/octet-stream') =>
    decl<`bytes:${string}`, Uint8Array>(`bytes:${mime}`, {
      contentType: mime,
      plane: 'stream',
      client: 'blob',
    }),
  text: (mime = 'text/plain; charset=utf-8') =>
    decl<'text', string>('text', { contentType: mime, plane: 'stream', client: 'text' }),

  /** one codec value per chunk, rendered as newline-delimited JSON at the edge. */
  ndjson: <S extends StandardSchemaV1>(schema: S) =>
    decl<'ndjson', StandardSchemaV1.InferOutput<S>>('ndjson', {
      contentType: 'application/x-ndjson',
      plane: 'flow',
      client: 'iterator',
      schema,
    }),

  /** one codec value per chunk, rendered as Server-Sent Events at the edge. */
  sse: <S extends StandardSchemaV1>(schema: S) =>
    decl<'sse', StandardSchemaV1.InferOutput<S>>('sse', {
      contentType: 'text/event-stream',
      plane: 'flow',
      client: 'events',
      schema,
    }),

  /** a multipart body: codec `fields` plus named byte streams. */
  parts: <S extends StandardSchemaV1 | null, TStreams extends string>(shape: {
    readonly fields?: S | undefined
    readonly streams: Readonly<Record<TStreams, StreamDef.Decl>>
  }): StreamDef.PartsDecl<
    S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : undefined,
    TStreams
  > => ({
    _t: PARTS_DECL,
    fields: shape.fields ?? null,
    streams: shape.streams,
  }),

  /** register a custom brand (content type + wire plane + client decoder). */
  brand: <B extends string, T = unknown>(brand: B, spec: StreamDef.BrandSpec) =>
    decl<B, T>(brand, spec),

  /** A Flow as a branded stream (pull-paced: backpressure reaches the flow). */
  *of<T, B extends string>(
    flow: Flow<T, unknown>,
    brand: B | StreamDef.Decl<B, T>,
  ): Operation<StreamDef.Branded<B, T>> {
    const name = typeof brand === 'string' ? brand : brand.brand
    return brandStream(yield* toReadable(flow), name)
  },

  /** A platform stream as a branded stream. */
  from: <T, B extends string>(readable: ReadableStream<T>, brand: B | StreamDef.Decl<B, T>) =>
    brandStream(readable, typeof brand === 'string' ? brand : brand.brand),

  /** Consume a branded stream as a Flow (the reader is cancelled when the consuming scope ends). */
  flow: <T>(branded: StreamDef.Branded<string, T>): Flow<T, void> => fromReadable(branded),
}
