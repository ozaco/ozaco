import type { ServerDef } from 'server:core'

import type { OtlpDef } from '../otlp'

export namespace OpenObserveDef {
  /** The kinds of rows the kernel observes, each shipped to its own stream — `domain` carries
   * the free-form `t: 'domain'` records (audit trails, business events). */
  export type StreamKey = 'requests' | 'spans' | 'logs' | 'failures' | 'events' | 'domain'

  export interface Options {
    /** The OpenObserve base url (`http://localhost:5080`); `/api/<org>/<stream>/_json` is
     * appended per stream. */
    readonly url: string

    /** the OpenObserve organization. Default `default`. */
    readonly org?: string | undefined

    /** `{ user, pass }` → HTTP basic (the root user / an ingestion user), `{ token }` → a
     * bearer token. Omit only for an unauthenticated deployment. */
    readonly auth?:
      | { readonly user: string; readonly pass: string }
      | { readonly token: string }
      | undefined

    /** per-kind stream names; `false` disables that kind. Defaults: the kind's own name. */
    readonly streams?: Partial<Readonly<Record<StreamKey, string | false>>> | undefined

    /** include the captured request content on `requests` records — headers (secrets
     * redacted), input and output, SUCCESS INCLUDED (big bodies are capped upstream: data ≤
     * 8KB, streams keep only their size). Default false. */
    readonly bodies?: boolean | undefined

    /** ALSO ingest through OpenObserve's OTLP endpoints: the setup installs an `OtlpExporter`
     * against `/api/<org>/v1/{traces,logs,metrics}` with the same auth — that is what lights up
     * the Traces, Logs and Metrics PANELS (the `_json` streams alone appear only under Logs →
     * Streams), so one install replaces the `OtlpExporter` + `OpenObserveExporter` pair.
     * `false` keeps just the streams (a separate OTLP collector, or streams-only ingestion);
     * the object passes these tuning options through. Default true. */
    readonly otlp?:
      | boolean
      | {
          /** ship log lines and failures to `/v1/logs`. Default true. */
          readonly logs?: boolean | undefined

          /** project WS frames and `ctx.emit`s into the trace as point-in-time spans;
           * `{ data: true }` carries the payloads. Default true, payloads off. */
          readonly events?: boolean | { readonly data?: boolean | undefined } | undefined

          /** cumulative metrics to `/v1/metrics`. `false` disables. */
          readonly metrics?:
            | false
            | { readonly intervalMs?: number | undefined; readonly buckets?: readonly number[] }
            | undefined
        }
      | undefined

    /** `service_name` stamped on every record. Default: the server's name. */
    readonly serviceName?: string | undefined

    /** extra fields stamped on every record (environment, region, …). */
    readonly resource?: Readonly<Record<string, string | number | boolean>> | undefined

    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly batch?: {
      readonly size?: number
      readonly waitMs?: number
      readonly maxPending?: number
    }

    /** `fetch` to use (tests). */
    readonly fetch?: typeof fetch | undefined
  }

  export interface Context extends ServerDef.PluginContext {
    readonly url: string
    readonly org: string

    readonly stats: () => Readonly<
      Record<StreamKey, { sent: number; dropped: number; failed: number }>
    > & {
      /** the embedded `OtlpExporter`'s counters — `null` when `otlp: false`. */
      readonly otlp: ReturnType<OtlpDef.Context['stats']> | null
    }
  }

  /** One delivery target (a stream's `_json` bulk endpoint). */
  export interface Target {
    readonly url: string
    readonly headers: Record<string, string>
    readonly fetch: typeof fetch
  }
}
