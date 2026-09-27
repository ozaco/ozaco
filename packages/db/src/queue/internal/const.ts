import type { QueueDef } from '../types/queue'

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

/** The trace-context columns `queueTable` declares — optional: a queue table declared without
 * them runs untraced. */
export const TRACE_COLUMNS = ['traceparent', 'tracestate', 'last_traceparent'] as const

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

/** `last_error` — the failure's whole chain (`formatFailure(f, { chain: true })`) — is budgeted to
 * this many UTF-8 bytes. */
export const ERROR_LIMIT = 4096

/** `messaging.system` of the queue's producer / consumer spans. */
export const MESSAGING_SYSTEM = 'ozaco.queue'

/** The exception event names of a failure originating in a producer / consumer span. */
export const SEND_EXCEPTION_EVENT = 'messaging.send.exception'
export const PROCESS_EXCEPTION_EVENT = 'messaging.process.exception'

/** The span event a dead-lettered attempt leaves on its consumer span. */
export const DEAD_EVENT = 'ozaco.queue.dead'

/** The status class an attempt's failure settles with: a dead letter is an error (ERROR record,
 * span status error); a failure with attempts left is handled by the retry (WARN, `error.type`
 * only). */
export const DEAD_STATUS = 500
export const RETRY_STATUS = 400
