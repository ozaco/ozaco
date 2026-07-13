import { operation } from 'std:effect'

import type { UlidOptions } from '../types/common'

// Crockford's base32 (no I/L/O/U) — lexicographic sort order matches numeric order.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10 // a 48-bit millisecond timestamp fits in 10 base32 chars
const DEFAULT_LEN = 26 // standard ULID body: 10 time + 16 random chars

// monotonic factory state (per process): within one `window` the random tail is incremented rather
// than re-rolled, so ids minted in the same window stay strictly ordered AND unique.
let lastWindow = -1
let lastRandom: number[] = []

const encodeTime = (ms: number): string => {
  let out = ''
  let n = ms
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[n % 32]! + out
    n = Math.floor(n / 32)
  }
  return out
}

// 256 % 32 === 0, so `byte % 32` is a UNIFORM base32 digit (no modulo bias). Web Crypto getRandomValues
// is available in node/bun/web alike, so this impl is shared across every IO platform.
const randomDigits = (count: number): number[] => {
  const bytes = new Uint8Array(count)
  crypto.getRandomValues(bytes)
  const digits: number[] = []
  for (let i = 0; i < count; i++) {
    digits.push(bytes[i]! % 32)
  }
  return digits
}

const bump = (digits: number[]): number[] => {
  const out = digits.slice()
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i]! < 31) {
      out[i]! += 1
      return out
    }
    out[i] = 0
  }
  return out // full-overflow (astronomically unlikely) wraps to a fresh window on the next call
}

/**
 * Generate a ULID: `[bucket]` + a 48-bit ms timestamp (10 Crockford-base32 chars) + a random tail.
 * Lexicographically sortable and monotonic within a `window`. Options:
 *   - `window` (ms, default 1): quantize the timestamp to `floor(now/window)*window` — larger windows
 *     coarsen the sortable time prefix and share it across more ids.
 *   - `length` (default 26): total id length EXCLUDING `bucket` (10 time chars + `length - 10` random).
 *   - `bucket` (default ''): a fixed prefix segment (namespace/shard tag); different buckets never collide.
 */
export const ulidId = operation(function* (options?: UlidOptions) {
  const window = options?.window ?? 1
  const length = options?.length ?? DEFAULT_LEN
  const bucket = options?.bucket ?? ''
  const randomCount = Math.max(1, length - TIME_LEN)

  const now = Date.now()
  const win = window > 1 ? Math.floor(now / window) * window : now

  // monotonic only when the window AND the random width match the previous call; a different `length`
  // (hence random width) in the same window must re-roll, not reuse the prior call's wider digit array
  const digits =
    win === lastWindow && lastRandom.length === randomCount
      ? bump(lastRandom)
      : randomDigits(randomCount)
  lastWindow = win
  lastRandom = digits

  let random = ''
  for (const d of digits) {
    random += ENCODING[d]!
  }
  return bucket + encodeTime(win) + random
})
