import { isFailure, throwable } from 'std:result'

import type { TransportDef } from 'transport:core'

import { str } from './zmtp'

/** Hub protocol payload helpers: headers cross as one JSON frame; an empty frame is "none". */

export const empty = (): Uint8Array => new Uint8Array(0)

/** The headers frame of a `PUB` / `MSG` back as a header map — a frame that is not a JSON object
 * of strings (a foreign peer's) reads as no headers. */
export const parseHeaders = (frame: Uint8Array | undefined): TransportDef.Headers => {
  if (frame === undefined || frame.length === 0) {
    return {}
  }

  const parsed = throwable(() => JSON.parse(str(frame)) as unknown)

  if (isFailure(parsed) || typeof parsed.value !== 'object' || parsed.value === null) {
    return {}
  }

  const headers: Record<string, string> = {}

  for (const [key, value] of Object.entries(parsed.value)) {
    if (typeof value === 'string') {
      headers[key] = value
    }
  }

  return headers
}
