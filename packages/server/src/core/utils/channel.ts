import { fail } from 'std:result'
import type { StandardSchemaV1 } from 'std:shared'

import { CHANNEL } from '../const'
import { CoreErrors } from '../errors'
import type { Channel, ChannelKind, Declaration, Schema, WireManifest } from '../types/channel'

import { isChannel, isSchema } from './is'

const makeChannel = <T, K extends ChannelKind>(
  kind: K,
  schema?: Schema,
  emits?: Schema,
): Channel<T, K> => ({ _t: CHANNEL, kind, schema, emits })

/** The codec-value plane (the handler's `params` / return value). */
export function value(): Channel<unknown, 'value'>
export function value<S extends Schema>(
  schema: S,
): Channel<StandardSchemaV1.InferOutput<S>, 'value'>
export function value(schema?: Schema): Channel<unknown, 'value'> {
  return makeChannel('value', schema)
}

/** A codec-value stream plane. */
export function stream(): Channel<unknown, 'stream'>
export function stream<S extends Schema>(
  schema: S,
): Channel<StandardSchemaV1.InferOutput<S>, 'stream'>
export function stream(schema?: Schema): Channel<unknown, 'stream'> {
  return makeChannel('stream', schema)
}

/** A raw byte stream plane (no schema — bytes pass through untouched). */
export const chunks = (): Channel<Uint8Array, 'chunks'> => makeChannel('chunks')

/** A multipart plane (fields + files). */
export const parts = (): Channel<unknown, 'parts'> => makeChannel('parts')

/** A bidirectional session plane (`schema` inbound, `emits` outbound). */
export function socket(): Channel<unknown, 'socket'>
export function socket<S extends Schema>(
  schema: S,
  emits?: Schema,
): Channel<StandardSchemaV1.InferOutput<S>, 'socket'>
export function socket(schema?: Schema, emits?: Schema): Channel<unknown, 'socket'> {
  return makeChannel('socket', schema, emits)
}

/** Normalizes a declaration: bare schema → one value channel; `undefined` → unconstrained value. */
export const normalizeDeclaration = (declaration?: Declaration): readonly Channel[] => {
  if (declaration === undefined) {
    return [makeChannel('value')]
  }

  if (isChannel(declaration)) {
    return [declaration]
  }

  if (isSchema(declaration)) {
    return [makeChannel('value', declaration)]
  }

  if (Array.isArray(declaration)) {
    if (declaration.length === 0) {
      throw fail(CoreErrors.Configuration, 'a channel declaration array cannot be empty')
    }

    for (const entry of declaration) {
      if (!isChannel(entry)) {
        throw fail(
          CoreErrors.Configuration,
          'channel declaration arrays may only contain channel() values',
        )
      }
    }

    const values = declaration.filter(entry => entry.kind === 'value')

    if (values.length > 1) {
      throw fail(CoreErrors.Configuration, 'a declaration may carry at most one value channel')
    }

    return declaration
  }

  throw fail(CoreErrors.Configuration, 'invalid channel declaration')
}

/** Resolves the serializable routing manifest ONCE at definition time. */
export const manifestOf = (
  input: readonly Channel[],
  output: readonly Channel[],
): WireManifest => ({
  input: input.map(channel => channel.kind),
  output: output.map(channel => channel.kind),
  streamingIn: input.some(channel => channel.kind !== 'value'),
  streamingOut: output.some(channel => channel.kind !== 'value'),
  bytesOut: output.some(channel => channel.kind === 'chunks'),
})

/** The schema of the value plane, when declared. */
export const valueSchemaOf = (channels: readonly Channel[]): Schema | undefined =>
  channels.find(channel => channel.kind === 'value')?.schema
