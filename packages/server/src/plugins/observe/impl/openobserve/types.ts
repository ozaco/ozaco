import type { ServerDef } from 'server:core'

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

    /** `service_name` stamped on every record. Default: the server's name. */
    readonly serviceName?: string | undefined

    /** extra fields stamped on every record (environment, region, …). */
    readonly resource?: Readonly<Record<string, string | number | boolean>> | undefined

    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly batch?: { readonly size?: number; readonly ms?: number; readonly maxPending?: number }

    /** `fetch` to use (tests). */
    readonly fetch?: typeof fetch | undefined
  }

  export interface Context extends ServerDef.PluginContext {
    readonly url: string
    readonly org: string

    readonly stats: () => Readonly<
      Record<StreamKey, { sent: number; dropped: number; failed: number }>
    >
  }

  /** One delivery target (a stream's `_json` bulk endpoint). */
  export interface Target {
    readonly url: string
    readonly headers: Record<string, string>
    readonly fetch: typeof fetch
  }
}
