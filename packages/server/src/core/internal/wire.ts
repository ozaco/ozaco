import type { Stream } from 'std:effect'
import { isArray } from 'std:shared'

import { CHANNEL, DataType } from '../const'
import type { Action } from '../types/action'
import type { Channel } from '../types/channel'
import type { Carried, Source } from '../types/source'

const isChannel = (value: unknown): value is Channel =>
  (value as Channel | undefined)?._t === CHANNEL

/**
 * Turn what the author wrote into what a carrier routes off.
 *
 * A bare schema is sugar for one `normal` value channel, so the everyday `input: z.object({ … })`
 * keeps working untouched while the richer forms sit beside it.
 *
 * Resolved ONCE, at definition time, and that is what makes the result un-forgeable downstream. The
 * previous core stated the same obligation in a docstring and left the value hand-written, so a byte
 * stream tagged as a value compiled fine and was served as one.
 */
const resolve = (declaration: Channel.Declaration | undefined): Channel[] => {
  if (declaration === undefined) {
    return []
  }
  if (isArray(declaration)) {
    return declaration.filter(isChannel)
  }
  if (isChannel(declaration)) {
    return [declaration]
  }
  return [{ _t: CHANNEL, type: DataType.normal, schema: declaration }]
}

/** The set of kinds present. A call carries at most one channel per kind, so this is a set. */
const kinds = (channels: Channel[]): DataType[] => [
  ...new Set(channels.map(channel => channel.type)),
]

export const resolveWire = (
  input: Channel.Declaration | undefined,
  output: Channel.Declaration | undefined,
): Action.Wire => {
  const resolvedInput = resolve(input)
  const resolvedOutput = resolve(output)

  return {
    input: resolvedInput,
    output: resolvedOutput,
    accepts: kinds(resolvedInput),
    produces: kinds(resolvedOutput),
  }
}

/** The one channel whose value becomes the handler's argument; everything else needs `useSource`. */
export const bodyChannel = (channels: Channel[]): Channel | undefined =>
  channels.find(channel => channel.type === DataType.normal)

/** Project a resolved declaration down to what a carrier can read on the far side. */
export const carriedOf = (channels: Channel[]): Carried[] =>
  channels.map(channel => ({ type: channel.type, bytes: channel.schema === undefined }))

/** The values a request carries on its `normal` channels — what a handler's arguments are built from. */
export const valuesOf = (sources: Source.Any[]): unknown[] =>
  sources
    .filter(source => source.type === DataType.normal)
    .map(source => (source as Source.Normal).value)

/** The lanes a request carries, in declaration order. */
export const lanesOf = (sources: Source.Any[]): Stream<unknown, unknown>[] =>
  sources
    .filter(source => source.type === DataType.stream)
    .map(source => (source as Source.Lane).stream)
