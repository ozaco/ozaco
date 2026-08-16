/**
 * `server:plugin/trace` — the tracing module: `DefaultTracer` (span factory + scope-bound batcher,
 * plus the W3C `traceparent` parse/format actions), `TracingPolicy` (a CLIENT span around every
 * dispatch, zero-cost without a tracer) and `MemoryExporter` (scope-bound sink for
 * tests/inspection). The OTLP/HTTP exporter lives in `server:plugin/trace/otlp`.
 */
export * from './const'
export * from './definition'
export type * from './types'
