/** WHATWG `readyState` values the connection inspects. */
export const CONNECTING = 0
export const OPEN = 1

/** Keepalive settings applied for every field a `keepalive` block leaves out. */
export const KEEPALIVE_DEFAULTS = {
  intervalMs: 30_000,
  payload: 'ping',
} as const

/** The close a scope teardown reports when no server-side close was observed. */
export const SCOPE_CLOSED = { code: 1000, reason: 'scope closed' } as const
