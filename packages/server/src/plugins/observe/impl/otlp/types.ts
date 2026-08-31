import type { ObserveDef, ServerDef, TraceDef } from 'server:core'

export namespace OtlpDef {
  export interface Options {
    /** The OTLP/HTTP base url (`http://localhost:4318`); `/v1/traces` + `/v1/logs` are appended. */
    readonly url: string
    readonly headers?: Readonly<Record<string, string>> | undefined

    /** `service.name` resource attribute. Default: the server's name. */
    readonly serviceName?: string | undefined

    /** extra resource attributes. */
    readonly resource?: Readonly<Record<string, string | number | boolean>> | undefined

    /** export logs and failures as OTLP log records too. Default true. */
    readonly logs?: boolean | undefined

    /** project observed EVENTS (WS frames, `ctx.emit`) into the trace as point-in-time spans
     * under the span they happened in — a socket session otherwise shows up as one empty span.
     * `false` drops them (chatty sockets); `{ data: true }` carries each frame's payload as the
     * `ozaco.data` attribute. Default true without payloads. */
    readonly events?: boolean | { readonly data?: boolean | undefined } | undefined

    /** export CUMULATIVE metrics to `/v1/metrics` — `ozaco.requests` (per kind/action/status),
     * the `ozaco.request.duration` histogram and `ozaco.failures` (per tag). `false` disables;
     * `intervalMs` (default 10000) paces the export, `buckets` are the histogram bounds (ms). */
    readonly metrics?:
      | false
      | { readonly intervalMs?: number | undefined; readonly buckets?: readonly number[] }
      | undefined
    readonly batch?:
      | { readonly size?: number; readonly waitMs?: number; readonly maxPending?: number }
      | undefined

    /** `fetch` to use (tests). */
    readonly fetch?: typeof fetch | undefined
  }

  export interface Context extends ServerDef.PluginContext {
    readonly url: string

    readonly stats: () => {
      readonly spans: { sent: number; dropped: number; failed: number }
      readonly logs: { sent: number; dropped: number; failed: number }

      /** metric EXPORTS (one per interval), not individual points. */
      readonly metrics: { sent: number; dropped: number; failed: number }
    }
  }

  /** OTLP JSON `AnyValue` (the subset we emit). */
  export type AnyValue =
    | { stringValue: string }
    | { intValue: string }
    | { doubleValue: number }
    | { boolValue: boolean }

  export interface KeyValue {
    readonly key: string
    readonly value: AnyValue
  }

  /** One delivery target. */
  export interface Target {
    readonly url: string
    readonly headers: Record<string, string>
    readonly fetch: typeof fetch
  }
}

/** The shapes this impl passes around inside itself. */
export namespace Helpers {
  export interface Counter {
    readonly attributes: OtlpDef.KeyValue[]
    count: number
  }

  export interface Histogram {
    readonly attributes: OtlpDef.KeyValue[]
    readonly bucketCounts: number[]
    count: number
    sum: number
  }

  /** CUMULATIVE metric state derived from what the kernel observes: entry spans (edge/dispatch)
   * count into `ozaco.requests` and the `ozaco.request.duration` histogram, failure rows into
   * `ozaco.failures`. `snapshot()` renders the OTLP `metrics` array of the current totals. */
  export interface OtlpMetrics {
    record(span: TraceDef.Span): void
    failure(row: ObserveDef.FailureRow): void
    snapshot(startNano: string, nowNano: string): Record<string, unknown>[]
  }
}
