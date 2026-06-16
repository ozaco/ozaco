import type { DaemonDef } from '../types'

const NO_RETRY: ResolvedRetry = { attempts: 1, delay: 0, backoff: 1, maxDelay: 30_000 }

const normalizeRetry = (retry: DaemonDef.Retry | number | undefined): ResolvedRetry => {
  if (retry === undefined) {
    return NO_RETRY
  }
  const raw = typeof retry === 'number' ? { attempts: retry } : retry
  return {
    attempts: raw.attempts ?? 3,
    delay: raw.delay ?? 0,
    backoff: raw.backoff ?? 1,
    maxDelay: raw.maxDelay ?? 30_000,
  }
}

export interface ResolvedRetry {
  attempts: number
  delay: number
  backoff: number
  maxDelay: number
}

export interface ResolvedFailure {
  mode: DaemonDef.FailMode
  retry: ResolvedRetry
}

/** Resolve the effective policy from the module override then the daemon default, field by field. */
export const resolveFailure = (
  primary: DaemonDef.Failure | undefined,
  fallback: DaemonDef.Failure | undefined,
): ResolvedFailure => ({
  mode: primary?.mode ?? fallback?.mode ?? 'all',
  retry: normalizeRetry(primary?.retry ?? fallback?.retry),
})

/** Backoff delay before the n-th retry (1-based), matching the server retry policy formula. */
export const retryDelay = (retry: ResolvedRetry, retriesSoFar: number): number =>
  Math.min(retry.delay * retry.backoff ** Math.max(0, retriesSoFar - 1), retry.maxDelay)
