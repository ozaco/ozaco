import type { BoundLogger } from 'server:utils'

/** Install-time options for `OtlpExporter`. */
export interface OtlpExporterOptions {
  /** Collector base URL, e.g. `http://localhost:4318` (otel-collector, Datadog Agent, Tempo). */
  readonly endpoint: string
  /** Path appended to `endpoint` (default `/v1/traces`). */
  readonly path?: string | undefined
  /** Extra request headers (auth tokens etc.), merged over the JSON `content-type`. */
  readonly headers?: Record<string, string> | undefined
  /** The `service.name` resource attribute (default `ozaco-server`). */
  readonly serviceName?: string | undefined
  /** Per-export request deadline in ms (default 10000). */
  readonly timeoutMs?: number | undefined
}

/** The exporter's scope-bound context: resolved options + module logger. */
export interface OtlpExporterContext {
  readonly url: string
  readonly headers: Record<string, string>
  readonly serviceName: string
  readonly timeoutMs: number
  readonly log: BoundLogger
}

/**
 * OTLP/HTTP JSON wire types (the protobuf-JSON mapping) — only the members this exporter emits.
 * 64-bit values (`intValue`, `*UnixNano`) travel as DECIMAL STRINGS per the protobuf JSON spec.
 */
export namespace Otlp {
  export interface AnyValue {
    readonly stringValue?: string | undefined
    readonly intValue?: string | undefined
    readonly doubleValue?: number | undefined
    readonly boolValue?: boolean | undefined
  }

  export interface KeyValue {
    readonly key: string
    readonly value: Otlp.AnyValue
  }

  export interface Event {
    readonly timeUnixNano: string
    readonly name: string
  }

  export interface Status {
    /** `STATUS_CODE_OK` = 1, `STATUS_CODE_ERROR` = 2. */
    readonly code: number
    readonly message?: string | undefined
  }

  export interface Span {
    readonly traceId: string
    readonly spanId: string
    readonly parentSpanId?: string | undefined
    readonly name: string
    /** `SPAN_KIND_INTERNAL` = 1, `SPAN_KIND_SERVER` = 2, `SPAN_KIND_CLIENT` = 3. */
    readonly kind: number
    readonly startTimeUnixNano: string
    readonly endTimeUnixNano: string
    readonly attributes: readonly Otlp.KeyValue[]
    readonly status: Otlp.Status
    readonly events: readonly Otlp.Event[]
  }

  /** The `ExportTraceServiceRequest` body POSTed to `/v1/traces`. */
  export interface ExportRequest {
    readonly resourceSpans: readonly {
      readonly resource: { readonly attributes: readonly Otlp.KeyValue[] }
      readonly scopeSpans: readonly {
        readonly scope: { readonly name: string }
        readonly spans: readonly Otlp.Span[]
      }[]
    }[]
  }
}
