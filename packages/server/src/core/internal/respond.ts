import { serializeError } from 'std:shared'

import { DataType } from '../const'
import type { Channel } from '../types/channel'
import type { Outcome, Response } from '../types/common'
import type { ActionResponse } from '../types/gateway'
import type { Source } from '../types/source'

/**
 * Turn what a handler returned into the sources its declaration promised.
 *
 * Only the action's own `output` declaration decides the shape — never a guess about the value. A
 * carrier that has to sniff a return value to learn whether it is a stream is one that will
 * eventually sniff wrong, and it did: a buffered `Uint8Array` was iterated as a stream and a plain
 * array was served byte by byte.
 */
export const toSources = <T>(value: T, channels: Channel[]): Source.Any<T>[] => {
  const declared = channels[0]

  if (!declared) {
    return value === undefined ? [] : [{ type: DataType.normal, value }]
  }

  if (declared.type === DataType.stream) {
    return [{ type: DataType.stream, stream: value as never }]
  }

  if (declared.type === DataType.multistream) {
    return [{ type: DataType.multistream, parts: value as never }]
  }

  return [{ type: DataType.normal, value }]
}

/**
 * Seal a draft into the envelope that travels.
 *
 * `status` is widened from the draft's `null` to `undefined`: "nobody set one" is one fact and it
 * should have one spelling on the wire.
 */
export const toResponse = <T>(draft: ActionResponse, sources: Source.Any<T>[]): Response<T> => ({
  status: draft.status ?? undefined,
  meta: draft.meta,
  sources,
})

export const emptyDraft = (): ActionResponse => ({
  status: null,
  meta: {},
  body: undefined,
})

/** `serializeError` so a thrown `Error` becomes a usable tag rather than `"Error: nope"`. */
export const toFault = (error: unknown, response?: Response): Outcome.Fault => ({
  tag: serializeError(error),
  ...(response === undefined ? {} : { response }),
})

/**
 * Wrap a value a POLICY produced into an envelope.
 *
 * The onion's `next()` answers with a {@link Response}, so a policy that substitutes a value —
 * a fallback, a cached hit — has to answer with one too. An app configures a plain value, and
 * rightly so: writing an envelope is not an application's job. This is the seam between the two.
 */
export const respondWith = <T>(value: T): Response<T> => ({
  status: undefined,
  meta: {},
  sources: value === undefined ? [] : [{ type: DataType.normal, value }],
})
