// oxlint-disable import/exports-last
import { FLAG_HAS_IS_REMOTE, FLAG_IS_REMOTE } from './const'

const NS_PER_MS = 1_000_000n

/**
 * Epoch milliseconds (with a sub-millisecond fraction) as epoch NANOSECONDS — whole
 * milliseconds and the fraction are converted apart, so nothing is lost to a double's 53 bits.
 */
export const nanosOf = (ms: number): bigint => {
  const whole = Math.floor(ms)

  return BigInt(whole) * NS_PER_MS + BigInt(Math.round((ms - whole) * 1e6))
}

/** 2^63 — the first magnitude an OTLP `int64` cannot hold. */
const INT64_LIMIT = 2 ** 63

/** A number OTLP carries as an `int64` (`intValue` / `asInt`); anything else is a `double`. */
export const isInt64 = (value: number): boolean =>
  Number.isInteger(value) && Math.abs(value) < INT64_LIMIT

/** Span / link `flags`: the W3C trace flags (low byte) + "is-remote known" + "is remote". */
export const spanFlags = (flags: number, remote: boolean | undefined): number =>
  FLAG_HAS_IS_REMOTE | (remote === true ? FLAG_IS_REMOTE : 0) | (flags & 0xff)
