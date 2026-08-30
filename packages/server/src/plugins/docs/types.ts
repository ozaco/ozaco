import type { ServiceDef } from 'server:core'

export namespace DocsDef {
  export interface Options {
    /** where the panel and the manifest live. Default `/docs` (+ `/docs/manifest`). */
    readonly path?: string | undefined
    readonly title?: string | undefined
  }

  /** JSON Schema (zod v4 `toJSONSchema`) or an opaque marker for non-zod Standard Schemas. */
  export type SchemaDoc = Record<string, unknown> | { readonly declared: true }

  export interface PlaneDoc {
    readonly plane: 'none' | 'value' | 'stream' | 'parts'
    readonly brand: string | null
    readonly contentType: string | null
    readonly schema: SchemaDoc | null

    /** `parts`: the named streams with their brands. */
    readonly streams?: Readonly<Record<string, string>> | undefined
  }

  /** The caller-facing summary of an `auth` requirement — WHAT is required, never a secret. */
  export interface AuthDoc {
    readonly kind:
      | 'open'
      | 'authenticated'
      | 'user'
      | 'service'
      | 'roles'
      | 'requirements'
      | 'predicate'
    readonly roles?: readonly string[] | undefined
    readonly permissions?: readonly string[] | undefined
  }

  export interface ActionDoc {
    readonly id: string
    readonly service: string
    readonly action: string
    readonly kind: ServiceDef.Kind
    readonly title: string | undefined
    readonly description: string | undefined
    readonly route: ServiceDef.Route
    readonly input: PlaneDoc
    readonly output: PlaneDoc
    readonly errors: Readonly<Record<string, number>>
    readonly tags: readonly string[]

    /** the `auth` requirement, summarized for the panel/clients. */
    readonly auth: AuthDoc

    /** the action's free-form `docs` block, verbatim (a resource's `filters` surface lives
     * here). */
    readonly docs: Readonly<Record<string, unknown>> | null

    /** plugin options as declared (functions dropped) — `auth`, `cache`, `rateLimit`, … */
    readonly options: Readonly<Record<string, unknown>>
  }

  /** A socket as a UNIFIED service entry (`kind: 'socket'`) — v2 has no separate socket list. */
  export interface SocketDoc {
    readonly id: string
    readonly service: string | null
    readonly action: string | null
    readonly kind: 'socket'
    readonly path: string

    /** `resource` = watch/unwatch ↔ sync/delta/error frames; anything else is custom. */
    readonly protocol: string | null
    readonly description: string | null

    /** `'first-frame'`: authorize with the FIRST `{ t: 'auth', token }` frame (browsers);
     * `'upgrade'`: an authorization header at the handshake. */
    readonly authorize: 'upgrade' | 'first-frame'

    /** opening-frame defaults (e.g. `{ cursor: 0 }` on realtime — start of the set). */
    readonly defaults?: Readonly<Record<string, unknown>> | null | undefined

    /** the declared frame schemas: what a client may send, what the server sends back. */
    readonly receives?: SchemaDoc | null | undefined
    readonly sends?: SchemaDoc | null | undefined
  }

  /** One entry of a service's unified `actions` list. */
  export type EntryDoc = ActionDoc | SocketDoc

  export interface ServiceDoc {
    readonly name: string
    readonly version: string
    readonly description: string | undefined

    /** the UNIFIED entry list: callable actions AND this service's sockets (`kind: 'socket'`). */
    readonly actions: readonly EntryDoc[]

    /** this service's failure catalog: the union of its actions' `errors`. */
    readonly errors: Readonly<Record<string, number>>
  }

  /** The Ozaco Manifest v2. */
  export interface Manifest {
    readonly manifest: 'ozaco/2'
    readonly name: string
    readonly version: string
    readonly instance: string
    readonly services: readonly ServiceDoc[]

    /** the CORE failure catalog (service-specific tags live on `services[].errors`). */
    readonly errors: Readonly<Record<string, number>>

    /** socket routes mounted OUTSIDE any service (`Edge.actions.socket`). */
    readonly edge: { readonly sockets: readonly SocketDoc[] }
    readonly observe: { readonly console: string | null }
    readonly docs: { readonly path: string; readonly openapi: string }
  }
}
