// oxlint-disable import/exports-last
import { fail } from 'std:result'

import type { Hlc, HlcOptions, ObserveHlcOptions } from '../types/common'

// Crockford's base32 (no I/L/O/U) — lexicographic order matches numeric order.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const DIGIT = new Map<string, number>()
for (const [index, char] of [...ENCODING].entries()) {
  DIGIT.set(char, index)
}
// decode tolerates lowercase and the letters Crockford treats as look-alikes
const ALIAS: Record<string, string> = { I: '1', L: '1', O: '0' }

/** Token layout: 48-bit ms time (10 chars) | 16-bit counter (4 chars) | 40-bit origin (8 chars). */
export const TIME_LEN = 10
export const COUNTER_LEN = 4
export const ORIGIN_LEN = 8
export const TOKEN_LEN = TIME_LEN + COUNTER_LEN + ORIGIN_LEN
export const COUNTER_MAX = 0xff_ff

const DEFAULT_MAX_DRIFT_MS = 60_000

const encodeNumber = (value: number, length: number): string => {
  let out = ''
  let rest = value
  for (let i = 0; i < length; i++) {
    out = ENCODING[rest % 32]! + out
    rest = Math.floor(rest / 32)
  }
  return out
}

const decodeNumber = (text: string): number | null => {
  let value = 0
  for (const raw of text) {
    const upper = raw.toUpperCase()
    const digit = DIGIT.get(ALIAS[upper] ?? upper)
    if (digit === undefined) {
      return null
    }
    value = value * 32 + digit
  }
  return value
}

// origins are strict (no look-alike aliasing): an origin is an identity, silently rewriting
// 'O' to '0' would make two spellings of one node collide
const normalizeOrigin = (origin: string): string | null => {
  if (origin.length !== ORIGIN_LEN) {
    return null
  }
  const upper = origin.toUpperCase()
  for (const char of upper) {
    if (!DIGIT.has(char)) {
      return null
    }
  }
  return upper
}

/** The validated, upper-cased origin or `null` when it is not 8 Crockford base32 characters
 * (`0-9 A-H J K M N P-T V-Z`; I/L/O/U are rejected, not aliased). */
export const originOf = (origin: string): string | null => normalizeOrigin(origin)

interface Clock {
  ts: number
  counter: number
}

// per-origin send state: one process may host several nodes (tests, pinned installs) and their
// counters must not interleave. `floor` is shared: a remote timestamp observed by any origin
// pulls every origin's notion of "now" forward (the HLC receive rule).
const clocks = new Map<string, Clock>()
const floor: Clock = { ts: 0, counter: -1 }

/** Mint a token: `ts = max(now, floor, last.ts)`, same-ms sends bump the counter, a counter
 * overflow spills into the next millisecond. */
export function* hlcToken(options: HlcOptions) {
  const origin = normalizeOrigin(options.origin)
  if (!origin) {
    return yield* fail(
      'hlc-invalid',
      `hlc origin must be ${ORIGIN_LEN} Crockford base32 characters, got "${options.origin}"`,
    )
  }
  const last = clocks.get(origin) ?? { ts: -1, counter: 0 }
  let ts = Math.max(Date.now(), floor.ts, last.ts)
  let counter = ts === last.ts ? last.counter + 1 : 0
  // a token minted at the observed floor's millisecond must sort AFTER the observed one
  if (ts === floor.ts) {
    counter = Math.max(counter, floor.counter + 1)
  }
  if (counter > COUNTER_MAX) {
    ts += 1
    counter = 0
  }
  clocks.set(origin, { ts, counter })
  return encodeNumber(ts, TIME_LEN) + encodeNumber(counter, COUNTER_LEN) + origin
}

/** Decode a token back to its parts; fails `hlc-invalid` on anything but a 22-char Crockford token. */
export function* hlcDecode(token: string) {
  if (typeof token !== 'string' || token.length !== TOKEN_LEN) {
    return yield* fail('hlc-invalid', `hlc token must be ${TOKEN_LEN} characters`)
  }
  const ts = decodeNumber(token.slice(0, TIME_LEN))
  const counter = decodeNumber(token.slice(TIME_LEN, TIME_LEN + COUNTER_LEN))
  const origin = normalizeOrigin(token.slice(TIME_LEN + COUNTER_LEN))
  if (ts === null || counter === null || origin === null) {
    return yield* fail('hlc-invalid', `hlc token "${token}" is not Crockford base32`)
  }
  return { ts, counter, origin } as Hlc
}

/** The receive rule: adopt a remote timestamp as the new floor unless it is implausibly far ahead
 * of the local clock (`maxDriftMs`). Returns whether the clock was adopted. */
export function* hlcObserve(token: string, options?: ObserveHlcOptions) {
  const remote = yield* hlcDecode(token)
  const maxDrift = options?.maxDriftMs ?? DEFAULT_MAX_DRIFT_MS
  if (remote.ts - Date.now() > maxDrift) {
    return false
  }
  if (remote.ts > floor.ts || (remote.ts === floor.ts && remote.counter > floor.counter)) {
    floor.ts = remote.ts
    floor.counter = remote.counter
  }
  return true
}
