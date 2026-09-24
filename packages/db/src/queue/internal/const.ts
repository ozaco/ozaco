import type { QueueDef } from '../types'

/** The columns `queueTable` declares — what `Queue.use` checks the named table carries. */
export const QUEUE_COLUMNS = [
  'kind',
  'payload',
  'state',
  'dedupe_key',
  'priority',
  'run_at',
  'attempts',
  'max_attempts',
  'lease_until',
  'worker',
  'last_error',
  'finished_at',
] as const

/** States a worker may claim from (`failed` = waiting for its retry). */
export const CLAIMABLE: readonly QueueDef.State[] = ['queued', 'failed']

/** States a dedupe key may be re-armed from. */
export const FINISHED: readonly QueueDef.State[] = ['done', 'dead']

export const DEFAULT_BACKOFF: QueueDef.Backoff = {
  kind: 'exponential',
  baseMs: 1000,
  maxMs: 300_000,
}
export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_POLL_MS = 1000
export const DEFAULT_LEASE_MS = 30_000

/** Lapsed leases handled per sweep round. */
export const SWEEP_BATCH = 100

/** `last_error` is capped at this many characters. */
export const ERROR_LIMIT = 2000
