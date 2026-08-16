import { attempt, each, operation } from 'std:effect'
import type { Flow } from 'std:effect'
import { fail, isFailure } from 'std:result'

import { JsonCodec } from 'std:codec/impl/json'

import { CoreErrors } from '../../errors'

const DECODER = new TextDecoder()

/** Buffers a request body, failing `payload-too-large` beyond the limit. */
export const readBody = operation(function* (source: Flow<Uint8Array, unknown>, maxBytes: number) {
  const chunks: Uint8Array[] = []
  let total = 0

  for (const chunk of yield* each(source)) {
    total += chunk.byteLength

    if (total > maxBytes) {
      return yield* fail(
        CoreErrors.PayloadTooLarge,
        `request body exceeds ${maxBytes} bytes`,
        'edge: read-body',
      )
    }

    chunks.push(chunk)
    yield* each.next()
  }

  const merged = new Uint8Array(total)
  let offset = 0

  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }

  return merged
})

/** Parses a JSON body — malformed input fails `bad-request` (never a raw codec error). */
export const parseJsonBody = operation(function* (bytes: Uint8Array) {
  if (bytes.byteLength === 0) {
    return undefined
  }

  const parsed = yield* attempt(() => JsonCodec.actions.parse<unknown>(DECODER.decode(bytes)))

  if (isFailure(parsed)) {
    return yield* fail(CoreErrors.BadRequest, 'malformed JSON body', 'edge: parse-body')
  }

  return parsed.value
})

export const parseUrlencoded = (bytes: Uint8Array): Record<string, string> => {
  const params = new URLSearchParams(DECODER.decode(bytes))
  const out: Record<string, string> = {}

  for (const [key, value] of params) {
    out[key] = value
  }

  return out
}

export const queryOf = (url: string): { path: string; query: Record<string, string> } => {
  const index = url.indexOf('?')

  if (index === -1) {
    return { path: url, query: {} }
  }

  const params = new URLSearchParams(url.slice(index + 1))
  const query: Record<string, string> = {}

  for (const [key, value] of params) {
    query[key] = value
  }

  return { path: url.slice(0, index), query }
}
