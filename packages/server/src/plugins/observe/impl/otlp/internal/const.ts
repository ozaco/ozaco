import type { TraceDef } from 'std:trace'

import pkg from '../../../../../../package.json'

/** OTLP `SpanKind` numbers. */
export const SPAN_KINDS: Readonly<Record<TraceDef.SpanKind, number>> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
}

/** OTLP `StatusCode.STATUS_CODE_ERROR` — the only status ever sent (unset is omitted, never ok). */
export const STATUS_ERROR = 2

/** OTLP `AggregationTemporality.CUMULATIVE`. */
export const CUMULATIVE = 2

/** Span / link `flags`: "the is-remote bit is known" (bit 8) and "is remote" (bit 9). */
export const FLAG_HAS_IS_REMOTE = 0x1_00
export const FLAG_IS_REMOTE = 0x2_00

export const CONTENT_TYPES = {
  protobuf: 'application/x-protobuf',
  json: 'application/json',
} as const

export const USER_AGENT = `ozaco-otlp-exporter-js/${pkg.version}`

/** Semconv's bucket advice for HTTP / RPC / messaging durations (seconds). */
export const DURATION_BUCKETS: readonly number[] = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
]

/** Series per metric before new attribute sets fold into one `otel.metric.overflow` series. */
export const METRIC_SERIES_LIMIT = 2000

/** OTLP/HTTP answers worth a retry (throttled / the gateway or the backend is not there yet). */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 502, 503, 504])

export const RETRY_DEFAULTS = { attempts: 5, initialMs: 1000, maxMs: 5000 } as const

/** Backoff growth per attempt and its ± jitter share. */
export const RETRY_MULTIPLIER = 1.5
export const RETRY_JITTER = 0.2

/** A `Retry-After` answer is honoured up to this long. */
export const RETRY_AFTER_CAP_MS = 30_000

export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_METRICS_INTERVAL_MS = 10_000

/** How much of a refusing backend's answer rides into the failure message. */
export const REPLY_EXCERPT_BYTES = 300

/** The logger binding (the record's scope) of the exporters' own delivery complaints. */
export const OBSERVE_LOGGER = '@ozaco/server/observe'
