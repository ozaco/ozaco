import type { Helpers } from 'std:effect'

declare module 'server:core' {
  interface PolicyOptionsMap {
    bulk: BulkOverride
  }
}

/** Install-time options for the bulkhead policy. */
export interface BulkOptions {
  /** Dispatches allowed to run at once per action (default 10). */
  readonly maxConcurrent?: number | undefined
  /** Dispatches allowed to wait for a slot per action (default 100). */
  readonly maxQueue?: number | undefined
  /** How long a queued dispatch may wait before failing, in milliseconds (default 30_000). */
  readonly queueTimeoutMs?: number | undefined
}

/** Per-action override (`policies: { bulk: { … } | false }`) — same shape as the options. */
export type BulkOverride = BulkOptions

/** One per-action lane: the running count plus the FIFO of dispatches waiting for a slot. */
export interface BulkLane {
  active: number
  readonly queue: Helpers.WithResolvers<void>[]
}

/** Scope-bound state: the resolved defaults plus the lanes keyed by `service\0action`. */
export interface BulkState {
  readonly lanes: Map<string, BulkLane>
  readonly maxConcurrent: number
  readonly maxQueue: number
  readonly queueTimeoutMs: number
}
