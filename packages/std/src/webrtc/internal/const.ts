/** Data-channel defaults: backpressure marks (bytes) and the open deadline (ms). */
export const CHANNEL_DEFAULTS = {
  highWaterMark: 1_048_576,
  lowWaterMark: 262_144,
  openTimeoutMs: 10_000,
} as const

/** How many timeline entries `peer.timeline` keeps unless `observe.timeline` says otherwise. */
export const TIMELINE_LIMIT = 128

/** How long the POLITE side yields the floor before an offer it initiated (glare avoidance). */
export const POLITE_YIELD_MS = 200
