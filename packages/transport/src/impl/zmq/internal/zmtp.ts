// oxlint-disable import/exports-last
import type { Helpers } from '../types/helpers'

import {
  FLAG_COMMAND,
  FLAG_LONG,
  FLAG_MORE,
  GREETING_BYTES,
  MECHANISM,
  ZMTP_MAJOR,
  ZMTP_MINOR,
} from './const'

/**
 * ZMTP 3.1 bytes (rfc.zeromq.org/spec/37): the 64-byte greeting, the command frames of the NULL
 * handshake (`READY`) and liveness (`PING` / `PONG`), and the message frames everything else
 * rides as. Pure: the decoder is an incremental state machine fed whatever the socket hands out,
 * so a greeting split in two (libzmq sends its signature first) or ten frames in one chunk read
 * the same.
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const text = (value: string): Uint8Array => encoder.encode(value)
export const str = (bytes: Uint8Array | undefined): string => (bytes ? decoder.decode(bytes) : '')

const concat = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0

  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }

  return out
}

/** Our greeting: signature, version 3.1, mechanism NULL, as-server 0, filler. */
export const greeting = (): Uint8Array => {
  const out = new Uint8Array(GREETING_BYTES)

  out[0] = 0xff
  out[9] = 0x7f
  out[10] = ZMTP_MAJOR
  out[11] = ZMTP_MINOR
  out.set(text(MECHANISM), 12)

  return out
}

/** One frame: flags, size (short ≤ 255 bytes, else 64-bit) and the body. */
const frame = (body: Uint8Array, flags: number): Uint8Array => {
  if (body.length <= 0xff) {
    const out = new Uint8Array(2 + body.length)

    out[0] = flags
    out[1] = body.length
    out.set(body, 2)

    return out
  }

  const out = new Uint8Array(9 + body.length)
  const view = new DataView(out.buffer)

  out[0] = flags | FLAG_LONG
  view.setUint32(1, Math.floor(body.length / 2 ** 32))
  view.setUint32(5, body.length >>> 0)
  out.set(body, 9)

  return out
}

/** A multipart message: every frame but the last flagged MORE. */
export const encodeMessage = (frames: readonly Uint8Array[]): Uint8Array =>
  concat(frames.map((body, index) => frame(body, index < frames.length - 1 ? FLAG_MORE : 0)))

/** A command frame: `name-size name data`. */
export const encodeCommand = (name: string, data: Uint8Array = new Uint8Array(0)): Uint8Array => {
  const label = text(name)

  return frame(concat([Uint8Array.of(label.length), label, data]), FLAG_COMMAND)
}

/** The NULL mechanism's `READY`: metadata properties (`Socket-Type` at least). */
export const encodeReady = (properties: Readonly<Record<string, string>>): Uint8Array => {
  const parts: Uint8Array[] = []

  for (const [name, value] of Object.entries(properties)) {
    const key = text(name)
    const val = text(value)
    const size = new Uint8Array(4)

    new DataView(size.buffer).setUint32(0, val.length)
    parts.push(Uint8Array.of(key.length), key, size, val)
  }

  return encodeCommand('READY', concat(parts))
}

/** `PING ttl context`: `ttl` in deciseconds is how long the peer may take to answer (rfc 37). */
export const encodePing = (timeoutMs: number): Uint8Array => {
  const ttl = new Uint8Array(2)

  new DataView(ttl.buffer).setUint16(0, Math.min(0xff_ff, Math.ceil(timeoutMs / 100)))

  return encodeCommand('PING', ttl)
}

/** `PING ttl context` → the `PONG context` that answers it. */
export const encodePong = (ping: Uint8Array): Uint8Array => encodeCommand('PONG', ping.subarray(2))

/** The properties of a `READY` body (`name-size name value-size value`…). */
export const parseReady = (data: Uint8Array): Record<string, string> => {
  const properties: Record<string, string> = {}
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let at = 0

  while (at < data.length) {
    const keyLength = data[at]!
    const key = str(data.subarray(at + 1, at + 1 + keyLength))

    at += 1 + keyLength

    if (at + 4 > data.length) {
      break
    }

    const valueLength = view.getUint32(at)

    at += 4
    properties[key] = str(data.subarray(at, at + valueLength))
    at += valueLength
  }

  return properties
}

/** The incremental ZMTP reader: feed it chunks, take the events (greeting, commands, messages).
 * A malformed stream yields one `error` event and nothing after it. */
export const createDecoder = (): Helpers.Decoder => {
  let buffer: Uint8Array = new Uint8Array(0)
  let greeted = false
  let dead = false
  let frames: Uint8Array[] = []

  const take = (count: number): Uint8Array => {
    const out = buffer.subarray(0, count)

    buffer = buffer.subarray(count)

    return out
  }

  const readGreeting = (): Helpers.ZmtpEvent | null => {
    // libzmq sends the 10-byte signature first and the rest once ours arrived: wait for all 64
    if (buffer.length < GREETING_BYTES) {
      return null
    }

    const head = take(GREETING_BYTES)

    if (head[0] !== 0xff || head[9] !== 0x7f || head[10] !== ZMTP_MAJOR) {
      return { t: 'error', reason: 'not a ZMTP 3 greeting' }
    }

    const mechanism = str(head.subarray(12, 32)).replaceAll('\0', '')

    if (mechanism !== MECHANISM) {
      return { t: 'error', reason: `unsupported mechanism "${mechanism}"` }
    }

    greeted = true

    return { t: 'greeting', minor: head[11]! }
  }

  const readFrame = (): Helpers.ZmtpEvent | null => {
    if (buffer.length < 2) {
      return null
    }

    const flags = buffer[0]!
    const long = (flags & FLAG_LONG) !== 0

    if (long && buffer.length < 9) {
      return null
    }

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    const high = long ? view.getUint32(1) : 0
    const size = long ? high * 2 ** 32 + view.getUint32(5) : buffer[1]!

    if (high > 0x1f_ff_ff) {
      return { t: 'error', reason: 'frame too large' }
    }

    const headerBytes = long ? 9 : 2

    if (buffer.length < headerBytes + size) {
      return null
    }

    take(headerBytes)

    // the body is copied out: `buffer` is a view over the socket's chunks, which it keeps slicing
    const body = new Uint8Array(take(size))

    if ((flags & FLAG_COMMAND) !== 0) {
      const nameLength = body[0] ?? 0

      return {
        t: 'command',
        name: str(body.subarray(1, 1 + nameLength)),
        data: body.subarray(1 + nameLength),
      }
    }

    frames.push(body)

    if ((flags & FLAG_MORE) !== 0) {
      return { t: 'more' }
    }

    const message = frames

    frames = []

    return { t: 'message', frames: message }
  }

  return {
    feed(chunk) {
      if (dead) {
        return []
      }

      buffer = buffer.length === 0 ? chunk : concat([buffer, chunk])

      const events: Helpers.ZmtpEvent[] = []

      for (;;) {
        const event = greeted ? readFrame() : readGreeting()

        if (event === null) {
          return events
        }

        if (event.t === 'error') {
          dead = true
          events.push(event)

          return events
        }

        if (event.t !== 'more') {
          events.push(event)
        }
      }
    },
  }
}
