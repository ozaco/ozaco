// oxlint-disable import/exports-last
import { redactQuery } from 'std:fetch'
import { asFailure } from 'std:result'
import type { TraceDef } from 'std:trace'

import type { ReadableStreamReadResult } from 'node:stream/web'

import { brandOf, isBranded } from '../utils/stream'

import { isDeferred } from './stream'

/** A captured body / frame keeps at most this many UTF-8 bytes (design §6.2: ≤ 2 KiB). */
export const CAPTURE_LIMIT = 2048

/** A captured header value keeps at most this many characters. */
const HEADER_LIMIT = 256

/** What a secret's value becomes in telemetry. */
const REDACTED = 'REDACTED'

/** The UTF-8 bytes `"REDACTED"` takes in JSON text. */
const REDACTED_JSON_BYTES = REDACTED.length + 2

/**
 * The ONE list of names whose values never reach telemetry, matched case-insensitively: header
 * names (capture `headers`), query keys (`url.query`, on top of `redactQuery`'s OTel list) and the
 * keys of JSON bodies, WS frames and multipart fields at ANY depth (capture `bodies` / `frames`).
 */
const SECRET = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'accesstoken',
  'refreshtoken',
  'api_key',
  'apikey',
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'client_secret',
  'private_key',
  'credential',
  'credentials',
  'session',
  'otp',
  'pin',
  'x-api-key',
  'x-auth-token',
  'x-amz-security-token',
])

/** Whether `name` (a header name, a query or JSON key) holds a secret. */
export const isSecret = (name: string): boolean => SECRET.has(name.toLowerCase())

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The UTF-8 byte length of `text`, without encoding it. */
export const byteLength = (text: string): number => {
  let bytes = 0

  for (let index = 0; index < text.length; index += 1) {
    const code = text.codePointAt(index) ?? 0

    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x8_00) {
      bytes += 2
    } else if (code < 0x1_00_00) {
      bytes += 3
    } else {
      // a surrogate pair: one 4-byte code point over two UTF-16 units
      bytes += 4
      index += 1
    }
  }

  return bytes
}

/** `text` cut to at most `limit` UTF-8 bytes (never inside a code point). */
export const cappedText = (text: string, limit = CAPTURE_LIMIT): string => {
  if (text.length <= limit / 4 || byteLength(text) <= limit) {
    return text
  }

  return decoder.decode(encoder.encode(text).slice(0, limit)).replace(/�+$/u, '')
}

/**
 * Headers as span attributes (design §6.2, capture `headers`): `http.<side>.header.<name>` →
 * `[value]` (lowercase semconv names), secrets `REDACTED`, long values capped.
 */
export const headerAttributes = (
  side: 'request' | 'response',
  headers: Headers,
): Record<string, string[]> => {
  const out: Record<string, string[]> = {}

  // oxlint-disable-next-line unicorn/no-array-for-each
  headers.forEach((value, key) => {
    const name = key.toLowerCase()

    out[`http.${side}.header.${name}`] = [
      isSecret(name)
        ? REDACTED
        : value.length > HEADER_LIMIT
          ? `${value.slice(0, HEADER_LIMIT)}…`
          : value,
    ]
  })

  return out
}

/** A query key as a server reads it (`+` is a space, percent-decoded). */
const queryKeyOf = (raw: string): string => {
  const spaced = raw.replaceAll('+', ' ')

  try {
    return decodeURIComponent(spaced)
  } catch {
    return spaced
  }
}

/**
 * A query string (no leading `?`) safe for telemetry (`url.query`): `redactQuery`'s OTel list, and
 * every key of the one secret list (`isSecret`), valued `REDACTED`; the rest byte for byte.
 */
export const queryText = (query: string): string =>
  redactQuery(query)
    .split('&')
    .map(part => {
      const at = part.indexOf('=')

      return at !== -1 && isSecret(queryKeyOf(part.slice(0, at)))
        ? `${part.slice(0, at)}=${REDACTED}`
        : part
    })
    .join('&')

/**
 * A value as capped JSON text + its full UTF-8 size; `null` when it cannot be rendered. Every
 * secret key (`isSecret`), at any depth, is rendered `"REDACTED"` — its whole value, an object or
 * array included; the size stays the value's own (what the body really weighed).
 */
const jsonOf = (value: unknown): { text: string; size: number } | null => {
  let text: string | undefined
  // what the REDACTED values weighed beyond `"REDACTED"` (the size is the real body's)
  let hidden = 0

  try {
    text = JSON.stringify(value, (key, item: unknown) => {
      if (key === '' || !isSecret(key)) {
        return item
      }

      const original = JSON.stringify(item)

      // a value JSON leaves out (a function, `undefined`) stays out
      if (original === undefined) {
        return item
      }

      hidden += byteLength(original) - REDACTED_JSON_BYTES

      return REDACTED
    })
  } catch {
    return null
  }

  return text === undefined ? null : { text: cappedText(text), size: byteLength(text) + hidden }
}

/**
 * A captured WS frame (`ozaco.ws.message.body`, capture `frames`): JSON re-rendered with every
 * secret key `REDACTED` (≤ 2 KiB) — `value` is the frame parsed; a frame that is no JSON object /
 * array is its text, capped.
 */
export const frameText = (text: string, value: unknown): string =>
  typeof value === 'object' && value !== null ? (jsonOf(value)?.text ?? '') : cappedText(text)

/**
 * One plane value as span attributes (design §6.2, capture `bodies`): the value plane as
 * `http.<side>.body.content` (JSON, ≤ 2 KiB, secret keys `REDACTED` at any depth) +
 * `http.<side>.body.size`; streams, flows and multipart parts as `ozaco.<side>.body.kind`
 * (buffering them would break the very thing observed — a stream's size is counted as it flows,
 * see {@link countingStream}), a multipart's fields redacted like a value.
 */
export const bodyAttributes = (
  side: 'request' | 'response',
  value: unknown,
): TraceDef.AttributesInput => {
  if (value === undefined) {
    return {}
  }

  if (isBranded(value)) {
    return { [`ozaco.${side}.body.kind`]: 'stream', [`ozaco.${side}.body.brand`]: brandOf(value) }
  }

  if (value instanceof ReadableStream) {
    return { [`ozaco.${side}.body.kind`]: 'stream' }
  }

  if (isDeferred(value)) {
    return { [`ozaco.${side}.body.kind`]: 'flow', [`ozaco.${side}.body.brand`]: value.brand }
  }

  if (
    value !== null &&
    typeof value === 'object' &&
    'fields' in value &&
    'streams' in value &&
    typeof (value as { streams: unknown }).streams === 'object'
  ) {
    const fields = jsonOf((value as { fields: unknown }).fields)

    return {
      [`ozaco.${side}.body.kind`]: 'parts',
      [`http.${side}.body.content`]: fields?.text,
    }
  }

  const json = jsonOf(value)

  return json
    ? { [`http.${side}.body.content`]: json.text, [`http.${side}.body.size`]: json.size }
    : {}
}

/** The bytes one body chunk puts on the wire: a string chunk (a `stream.text` body) in UTF-8, a
 * byte chunk (`Uint8Array`, any view, an `ArrayBuffer`) by its length. */
const chunkBytes = (chunk: unknown): number => {
  if (typeof chunk === 'string') {
    return byteLength(chunk)
  }

  const size = (chunk as { byteLength?: unknown } | null)?.byteLength

  return typeof size === 'number' ? size : 0
}

/**
 * A byte-counting pass-through: the stream flows untouched; `done` receives the total once it
 * ends — read to the end (`{}`), failed (`{ failure }`) or cancelled by its consumer
 * (`{ cancelled: true }`) — exactly once. Big bodies are observed as a SIZE, never buffered, and a
 * span can end WITH its body.
 */
export const countingStream = (
  source: ReadableStream<Uint8Array>,
  done: (bytes: number, end: TraceDef.EndOptions) => void,
): ReadableStream<Uint8Array> => {
  const reader = source.getReader()
  let total = 0
  let settled = false

  const settle = (end: TraceDef.EndOptions): void => {
    if (!settled) {
      settled = true
      done(total, end)
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let step: ReadableStreamReadResult<Uint8Array>

      try {
        step = await reader.read()
      } catch (error) {
        controller.error(error)
        settle({ failure: asFailure(error) })
        return
      }

      if (step.done) {
        if (controller.desiredSize !== null) {
          controller.close()
        }

        settle({})
        return
      }

      total += chunkBytes(step.value)
      controller.enqueue(step.value)
    },

    cancel: async reason => {
      settle({ cancelled: true })
      await reader.cancel(reason).catch(() => {})
    },
  })
}
