import type { Wire } from 'server:core'

declare module 'server:core' {
  interface PolicyOptionsMap {
    retry: RetryOverride
  }
}

/**
 * Install-time options for the retry policy. The default `when` retries ONLY raised failures
 * tagged `CoreErrors.TimeoutUnreached` or `CoreErrors.Unavailable` — never `TimeoutPending`
 * (outcome unknown) and never business `failure` replies.
 */
export interface RetryOptions {
  /** Maximum tries including the first one (default 3). */
  readonly attempts?: number | undefined
  /** Backoff delay of the first retry in milliseconds (default 250). */
  readonly delayMs?: number | undefined
  /** Exponential growth factor per retry (default 2). */
  readonly factor?: number | undefined
  /** Upper bound on the computed backoff delay (default 30_000). */
  readonly maxDelayMs?: number | undefined
  /** Retry predicate — `raised` is `true` for raised failures, `false` for `failure` replies. */
  readonly when?: ((failure: Wire.Failure, raised: boolean) => boolean) | undefined
}

/** Per-action override (`policies: { retry: { … } | false }`) — same shape as the options. */
export type RetryOverride = RetryOptions

/** Scope-bound state: the fully resolved options. */
export interface RetryState {
  readonly attempts: number
  readonly delayMs: number
  readonly factor: number
  readonly maxDelayMs: number
  readonly when: (failure: Wire.Failure, raised: boolean) => boolean
}
