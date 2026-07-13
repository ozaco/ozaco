import { operation } from 'std:effect'

const HEX = '0123456789abcdef'

/**
 * Generate an RFC 4122 version-4 (random) UUID, e.g. `f47ac10b-58cc-4372-a567-0e02b2c3d479`.
 * Uses Web Crypto `getRandomValues` (present in node/bun/web alike) so the impl is shared across every
 * IO platform — and, unlike `crypto.randomUUID`, works in non-secure browser contexts too.
 */
export const uuidId = operation(function* () {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 10xx

  let out = ''
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) {
      out += '-'
    }
    const byte = bytes[i]!
    out += HEX[byte >> 4]! + HEX[byte & 0x0f]!
  }
  return out
})
