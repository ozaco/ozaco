export namespace CorsDef {
  export interface Options {
    /** Allowed origins, or `'*'` for any. Default `'*'`. */
    readonly origins?: readonly string[] | '*' | undefined

    /** Preflight `access-control-allow-methods`. Default GET,POST,PUT,PATCH,DELETE,OPTIONS. */
    readonly methods?: readonly string[] | undefined

    /** Preflight `access-control-allow-headers`. Default content-type, authorization,
     * x-request-id, idempotency-key, traceparent, tracestate (W3C trace context in, so a
     * browser's traced call continues its trace). */
    readonly headers?: readonly string[] | undefined

    /** `access-control-expose-headers` on every response. Default x-request-id, oz-brand,
     * oz-error, traceresponse (a browser can read the request id and the trace it landed in). */
    readonly exposeHeaders?: readonly string[] | undefined

    /** Send `access-control-allow-credentials` and always echo the specific origin. */
    readonly credentials?: boolean | undefined

    /** Preflight `access-control-max-age` in seconds. Default 600. */
    readonly maxAgeSeconds?: number | undefined
  }

  export interface Config {
    readonly origins: readonly string[] | '*'
    readonly methods: string
    readonly headers: string
    readonly exposeHeaders: string
    readonly credentials: boolean
    readonly maxAgeSeconds: number
  }

  /** Why the browser will refuse a cross-origin request — `ozaco.cors.reason`: its origin is
   * not allowed, or its preflight asks for a method / headers the answer does not allow. */
  export type Reason = 'origin' | 'method' | 'headers'

  /** How CORS answers one request (see `verdictOf`). */
  export interface Verdict {
    /** the origin to echo; `null` = not allowed. */
    readonly origin: string | null

    /** an `OPTIONS` carrying `access-control-request-method`. */
    readonly preflight: boolean

    /** an `origin` header that is not the page's own — what the telemetry covers. */
    readonly cross: boolean

    /** why the browser will refuse it; `null` = allowed. */
    readonly reason: Reason | null
  }
}
