import type { ServerDef } from 'server:core'

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

    /** export CUMULATIVE metrics to `/v1/metrics` — `ozaco.requests` (per kind/action/status),
     * the `ozaco.request.duration` histogram and `ozaco.failures` (per tag). `false` disables;
     * `intervalMs` (default 10000) paces the export, `buckets` are the histogram bounds (ms). */
    readonly metrics?:
      | false
      | { readonly intervalMs?: number | undefined; readonly buckets?: readonly number[] }
      | undefined
    readonly batch?: { readonly size?: number; readonly ms?: number; readonly maxPending?: number }

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
