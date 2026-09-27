import type { ObserveDef } from 'server:core'

import type { OtlpDef } from '../otlp'

export namespace OpenObserveDef {
  /**
   * OpenObserve through its OTLP/HTTP endpoints (`/api/<org>/v1/{traces,logs,metrics}`) — the
   * same encoder, content and transport as `OtlpExporter`. Options are TRANSPORT ONLY.
   */
  export interface Options {
    /** The OpenObserve base url (`http://localhost:5080`). */
    readonly url: string

    /** the OpenObserve organization. Default `default`. */
    readonly org?: string | undefined

    /** `{ user, pass }` → HTTP basic (the root user / an ingestion user), `{ token }` → a
     * bearer token. Omit only for an unauthenticated deployment. */
    readonly auth?:
      | { readonly user: string; readonly pass: string }
      | { readonly token: string }
      | undefined

    /** the `stream-name` the traces and log records land in — one name for both, or per signal.
     * Default: OpenObserve's own (`default`). */
    readonly stream?:
      | string
      | { readonly traces?: string | undefined; readonly logs?: string | undefined }
      | undefined

    /** Default `'protobuf'` — OpenObserve refuses a whole OTLP/JSON batch over one fractional
     * `doubleValue`; protobuf carries it. */
    readonly encoding?: OtlpDef.Encoding | undefined
    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly gzip?: boolean | undefined
    readonly timeoutMs?: number | undefined
    readonly retry?: OtlpDef.Options['retry']
    readonly batch?: OtlpDef.Batch | undefined
    readonly metrics?: OtlpDef.Options['metrics']

    /** `fetch` to use (tests). */
    readonly fetch?: typeof fetch | undefined
  }

  export interface Context extends ObserveDef.ExporterContext, OtlpDef.Pipeline {
    readonly org: string
  }
}
