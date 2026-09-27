import type { Helpers } from '../types/helpers'

import { MAX_CLOCK_DRIFT_MS } from './const'

const hasPerformance = typeof performance !== 'undefined' && typeof performance.now === 'function'

const monotonic: () => number = hasPerformance ? () => performance.now() : () => Date.now()

/** The process anchor: when the monotonic clock started, in epoch milliseconds with a
 * sub-millisecond part (`performance.timeOrigin`). */
const ORIGIN: Helpers.Anchor | undefined =
  hasPerformance && Number.isFinite(performance.timeOrigin)
    ? Object.freeze({ wall: performance.timeOrigin, mono: 0 })
    : undefined

let shared: Helpers.Anchor | undefined

/** Whether `anchor` reads the wall clock `wall` (at monotonic `mono`) within the drift budget. */
const holds = (anchor: Helpers.Anchor, mono: number, wall: number): boolean =>
  Math.abs(anchor.wall + (mono - anchor.mono) - wall) <= MAX_CLOCK_DRIFT_MS

/**
 * The clock a local root anchors to: ONE per process — `performance.timeOrigin` against the
 * monotonic clock, sub-millisecond — so every local trace in the process (a node's span under
 * another node's, same process) reads the same time line and a child never starts before its
 * parent. (A per-root `Date.now()` anchor was cut to whole milliseconds: a later root could anchor
 * up to 1 ms early.) While it drifted more than {@link MAX_CLOCK_DRIFT_MS} from `Date.now()` (a
 * suspended machine stops the monotonic clock; an NTP step moves the wall one), the anchor is
 * `Date.now()` at the time — back to the process one once that holds again.
 */
export const anchorNow = (): Helpers.Anchor => {
  const mono = monotonic()
  const wall = Date.now()

  if (!shared || !holds(shared, mono, wall)) {
    shared = ORIGIN && holds(ORIGIN, mono, wall) ? ORIGIN : { wall, mono }
  }

  return shared
}

/** Now on `anchor`'s clock: the anchor's wall time plus the monotonic time elapsed since. */
export const timeOf = (anchor: Helpers.Anchor): number => anchor.wall + (monotonic() - anchor.mono)

/** `time` clamped into `[start, end]`. */
export const clamp = (time: number, start: number, end: number): number =>
  Math.min(Math.max(time, start), Math.max(start, end))
