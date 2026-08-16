/**
 * `TracingPolicy` sits between `PolicyPriority.metrics` (50) and `PolicyPriority.timeout` (60):
 * inside the metrics observer, outside the timeout, so every timed-out dispatch still gets a span.
 */
export const TRACING_PRIORITY = 55

/** Default pump flush cadence (ms) when `flushIntervalMs` is not given. */
export const TRACE_FLUSH_INTERVAL_MS = 5000

/** Default buffered snapshot count that triggers an immediate flush when `batchSize` is not given. */
export const TRACE_BATCH_SIZE = 512

/** Default inspection ring capacity when `keep` is not given. */
export const TRACE_KEEP = 2048

/** The span attribute carrying `setStatus`'s message — OTel's status description convention. */
export const STATUS_DESCRIPTION_ATTRIBUTE = 'otel.status_description'
