/** WHATWG `readyState` values the connection inspects. */
export const CONNECTING = 0
export const OPEN = 1

/** Reconnect settings applied for every field a `reconnect` block leaves out. */
export const RECONNECT_DEFAULTS = {
  retries: 5,
  delayMs: 250,
  backoff: 1,
  maxDelayMs: 30_000,
} as const

/** Keepalive settings applied for every field a `keepalive` block leaves out. */
export const KEEPALIVE_DEFAULTS = {
  intervalMs: 30_000,
  payload: 'ping',
} as const

/** The close a scope teardown reports when no server-side close was observed. */
export const SCOPE_CLOSED = { code: 1000, reason: 'scope closed' } as const
