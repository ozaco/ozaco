/**
 * `server:policy/rate-limit` — token-bucket rate limiting per action (and per principal by
 * default). Exhausted buckets raise `CoreErrors.RateLimited`, which maps to HTTP 429 at the edge.
 */
export * from './definition'
export type * from './types'
