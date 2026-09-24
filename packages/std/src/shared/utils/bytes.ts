const HEX = '0123456789abcdef'

// `String.fromCodePoint(...chunk)` spreads onto the stack: bounded chunks keep a large buffer safe
const CHUNK = 0x80_00

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
