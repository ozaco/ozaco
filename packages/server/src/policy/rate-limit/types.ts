import type { TokenBucket } from 'server:utils'

declare module 'server:core' {
  interface PolicyOptionsMap {
    'rate-limit': RateLimitOverride
  }
}

/** Install-time options for the rate-limit policy. */
export interface RateLimitOptions {
  /** Maximum burst size — the token bucket starts full at this many tokens. */
  readonly capacity: number
  /** Continuous refill rate in tokens per second (0 disables refill). */
  readonly refillPerSecond: number
  /** Limit identity: `principal` gives every caller its own bucket, `none` shares one (default `principal`). */
  readonly vary?: 'principal' | 'none' | undefined
}

/** Per-action override (`policies: { 'rate-limit': { … } | false }`). */
export interface RateLimitOverride {
  readonly capacity?: number | undefined
  readonly refillPerSecond?: number | undefined
  readonly vary?: 'principal' | 'none' | undefined
}

/** Scope-bound state: the resolved defaults plus the lazily-created buckets per limit key. */
export interface RateLimitState {
  readonly buckets: Map<string, TokenBucket>
  readonly capacity: number
  readonly refillPerSecond: number
  readonly vary: 'principal' | 'none'
}
