/** Default carrier name in the routing table (`options.name` overrides). */
export const WORKER_TRANSPORT_NAME = 'worker'

/** Default routing priority — after the internal carrier (0), before wide-area carriers. */
export const WORKER_TRANSPORT_PRIORITY = 5

/** The single output lane a `reply-stream` feeds on this carrier. */
export const OUTPUT_LANE = '0'

/** How long owner-side replies stay replayable for duplicate `idempotencyKey` dispatches. */
export const REPLY_CACHE_TTL_MS = 600_000

/** Producer-side credit window per (cid, lane): max items in flight (sent − granted) before parking. */
export const LANE_WINDOW = 128

/** Consumer-side credit cadence: one `lane-credit` envelope per this many consumed items. */
export const LANE_CREDIT_STEP = 32
