import { CHUNK, ELLIPSIS, ELLIPSIS_BYTES, HEX } from '../internal/const'
import { pointBytes } from '../internal/utf8'

/** Lowercase hex of `bytes` (two chars per byte). */
export const toHex = (bytes: Uint8Array): string => {
  let out = ''

  for (const byte of bytes) {
    out += HEX[byte >> 4]! + HEX[byte & 15]!
  }

  return out
}

/** Standard (padded) base64 of `bytes` — `btoa` over a binary string, no `Buffer` needed. */
export const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''

  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCodePoint(...bytes.subarray(at, at + CHUNK))
  }

  return btoa(binary)
}

/**
 * Decode base64 into bytes. Lenient on input shape: the URL-safe alphabet (`-` / `_`), missing
 * padding and whitespace are accepted; any other invalid character throws `atob`'s
 * `InvalidCharacterError`.
 */
export const fromBase64 = (text: string): Uint8Array => {
  const normalized = text.replaceAll(/\s+/gu, '').replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
  const binary = atob(padded)

  const out = new Uint8Array(binary.length)

  for (let at = 0; at < binary.length; at += 1) {
    out[at] = binary.codePointAt(at)!
  }

  return out
}

/** The UTF-8 byte length of `text`, without encoding it. */
export const utf8Length = (text: string): number => {
  let bytes = 0

  for (const char of text) {
    bytes += pointBytes(char.codePointAt(0) ?? 0)
  }

  return bytes
}

/** `text` cut on a code-point boundary to at most `max` UTF-8 bytes, a cut marked with `…`. */
export const capUtf8 = (text: string, max: number): string => {
  // every UTF-16 unit encodes to at most 3 bytes: short strings never need the exact count
  if (text.length * 3 <= max || utf8Length(text) <= max) {
    return text
  }

  if (max < ELLIPSIS_BYTES) {
    return ''
  }

  const budget = max - ELLIPSIS_BYTES
  let bytes = 0
  let cut = ''

  for (const char of text) {
    const size = pointBytes(char.codePointAt(0) ?? 0)

    if (bytes + size > budget) {
      break
    }

    bytes += size
    cut += char
  }

  return `${cut}${ELLIPSIS}`
}
