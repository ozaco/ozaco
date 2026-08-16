/** Install-time options — every field has a sensible default (see `definition.ts`). */
export interface CorsOptions {
  /** Allowed origins, or `'*'` for any (default `'*'`). */
  readonly origins?: readonly string[] | '*' | undefined
  /** Preflight `access-control-allow-methods` (default GET,POST,PUT,PATCH,DELETE,OPTIONS). */
  readonly methods?: readonly string[] | undefined
  /** Preflight `access-control-allow-headers` (default content-type, authorization, x-request-id). */
  readonly headers?: readonly string[] | undefined
  /** `access-control-expose-headers` on every response (default x-request-id). */
  readonly exposeHeaders?: readonly string[] | undefined
  /** Send `access-control-allow-credentials` and always echo the specific origin (default false). */
  readonly credentials?: boolean | undefined
  /** Preflight `access-control-max-age` in seconds (default 600). */
  readonly maxAgeSeconds?: number | undefined
}

/** The resolved (pre-joined) configuration held as the plugin context — never mutated. */
export interface CorsConfig {
  readonly origins: readonly string[] | '*'
  readonly methods: string
  readonly headers: string
  readonly exposeHeaders: string
  readonly credentials: boolean
  readonly maxAgeSeconds: number
}
