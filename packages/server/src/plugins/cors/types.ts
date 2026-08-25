export namespace CorsDef {
  export interface Options {
    /** Allowed origins, or `'*'` for any. Default `'*'`. */
    readonly origins?: readonly string[] | '*' | undefined

    /** Preflight `access-control-allow-methods`. Default GET,POST,PUT,PATCH,DELETE,OPTIONS. */
    readonly methods?: readonly string[] | undefined

    /** Preflight `access-control-allow-headers`. Default content-type, authorization,
     * x-request-id, idempotency-key. */
    readonly headers?: readonly string[] | undefined

    /** `access-control-expose-headers` on every response. Default x-request-id, oz-brand,
     * oz-error. */
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
}
