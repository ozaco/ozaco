import type { ServerDef } from 'server:core'

export namespace StarRocksDef {
  export interface Options {
    /** The FE HTTP url (`http://fe:8030`) — Stream Load goes to `/api/<db>/<table>/_stream_load`. */
    readonly url: string
    readonly database: string

    /** table names. Default `ozaco_requests` / `ozaco_spans`; `null` disables that feed. */
    readonly tables?:
      | { readonly requests?: string | null; readonly spans?: string | null }
      | undefined
    readonly user?: string | undefined
    readonly password?: string | undefined

    /** extra Stream Load headers (e.g. `timezone`, `max_filter_ratio`). */
    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly batch?: { readonly size?: number; readonly ms?: number; readonly maxPending?: number }

    /** `fetch` to use (tests). */
    readonly fetch?: typeof fetch | undefined
  }

  /** One row of the requests table. */
  export interface RequestMetric {
    readonly ts: string
    readonly request_id: string
    readonly origin: string
    readonly service: string | null
    readonly action: string | null
    readonly edge: string | null
    readonly method: string | null
    readonly path: string | null
    readonly status: number | null
    readonly duration_ms: number | null
    readonly service_id: string
    readonly instance: string
    readonly error: string | null
  }

  /** One row of the spans table. */
  export interface SpanMetric {
    readonly ts: string
    readonly request_id: string
    readonly span_id: string
    readonly parent_span_id: string | null
    readonly kind: string
    readonly name: string
    readonly service_id: string
    readonly action: string | null
    readonly transport: string | null
    readonly duration_ms: number
    readonly status: string
    readonly instance: string
  }

  export interface Context extends ServerDef.PluginContext {
    readonly stats: () => {
      readonly requests: { sent: number; dropped: number; failed: number }
      readonly spans: { sent: number; dropped: number; failed: number }
    }
  }

  /** One delivery target. */
  export interface Load {
    readonly url: string
    readonly headers: Record<string, string>
    readonly fetch: typeof fetch
    readonly label: () => string
  }
}
