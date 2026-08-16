import type { Reply } from 'server:core'

declare module 'server:core' {
  interface PolicyOptionsMap {
    cache: CacheOverride
  }
}

/** Install-time options for the cache policy. */
export interface CacheOptions {
  /**
   * Cache EVERY value reply, not just actions that declare `policies: { cache: … }` (default
   * `false`). Without it, installing the policy only arms the per-action overrides — an
   * undeclared action is never cached, so per-request values (ids, timestamps) stay fresh.
   */
  readonly global?: boolean | undefined
  /** How long a cached reply stays fresh, in milliseconds (default 30_000). */
  readonly ttlMs?: number | undefined
  /** Maximum number of cached entries — the oldest entry is evicted beyond it (default 1000). */
  readonly max?: number | undefined
  /** Cache identity: `principal` isolates entries per caller, `none` shares them (default `principal`). */
  readonly vary?: 'principal' | 'none' | undefined
}

/** Per-action override (`policies: { cache: { … } | false }`). */
export interface CacheOverride {
  readonly ttlMs?: number | undefined
  readonly vary?: 'principal' | 'none' | undefined
}

/** One cached reply and the moment it stops being served. */
export interface CacheEntry {
  readonly reply: Reply
  readonly expiresAt: number
}

/** Scope-bound cache state: the resolved options plus the insertion-ordered entries map. */
export interface CacheState {
  readonly entries: Map<string, CacheEntry>
  readonly global: boolean
  readonly ttlMs: number
  readonly max: number
  readonly vary: 'principal' | 'none'
}
