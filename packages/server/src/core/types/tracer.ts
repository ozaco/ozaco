import type { Operation } from 'std:effect'

/** OTel-shaped span identity — kept so OTLP exporters (Datadog, collector) can integrate later. */
export interface SpanContext {
  readonly traceId: string
  readonly spanId: string
  readonly parentSpanId?: string | undefined
}

/** Cold span/exporter record types of the tracer protocol (types-only namespace). */
export namespace TracerDef {
  export type SpanKind = 'client' | 'server' | 'internal'

  export interface SpanOptions {
    readonly kind?: SpanKind | undefined
    readonly parent?: SpanContext | undefined
    readonly attributes?: Record<string, string | number | boolean> | undefined
  }

  export interface SpanSnapshot {
    readonly name: string
    readonly kind: SpanKind
    readonly context: SpanContext
    readonly startMs: number
    readonly endMs: number
    readonly status: 'ok' | 'error'
    readonly attributes: Record<string, string | number | boolean>
    readonly events: readonly { readonly ts: number; readonly message: string }[]
  }
}

export interface Span {
  readonly context: SpanContext
  setAttribute(key: string, value: string | number | boolean): void
  recordException(message: string): void
  setStatus(status: 'ok' | 'error', message?: string): void
  end(): void
}

/** Span factory — the DefaultTracer impl lands in `server:trace` (phase 5). */
export interface TracerActions {
  startSpan(name: string, options?: TracerDef.SpanOptions): Operation<Span>
  /**
   * Parse a W3C `traceparent` header into the remote {@link SpanContext} local spans should
   * parent under — `undefined` for anything malformed (strict: version 00, lowercase hex,
   * all-zero ids invalid).
   */
  parseTraceparent(header: string): Operation<SpanContext | undefined>
  /** Render `context` as an outbound W3C `traceparent` header (version 00, sampled flags). */
  formatTraceparent(context: SpanContext): Operation<string>
}

/** Pluggable span sink — OTLP/HTTP impl (Datadog Agent, otel-collector, Tempo) in `server:trace`. */
export interface TraceExporterActions {
  export(spans: readonly TracerDef.SpanSnapshot[]): Operation<void>
  flush(): Operation<void>
}
