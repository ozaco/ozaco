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

    /** plugin options as declared (functions dropped) — `auth`, `cache`, `rateLimit`, … */
    readonly options: Readonly<Record<string, unknown>>
  }

  /** A socket route (a resource's realtime feed, a custom socket). */
  export interface SocketDoc {
    readonly path: string
    readonly service: string | null

    /** `resource` = watch/unwatch ↔ sync/delta/error frames; anything else is custom. */
    readonly protocol: string | null
    readonly description: string | null

    /** opening-frame defaults (e.g. `{ cursor: 0 }` on realtime — start of the set). */
    readonly defaults?: Readonly<Record<string, unknown>> | null | undefined
  }

  export interface ServiceDoc {
    readonly name: string
    readonly version: string
    readonly description: string | undefined
    readonly actions: readonly ActionDoc[]

    /** socket routes under this service (e.g. a crud resource's `/<name>/_realtime`). */
    readonly sockets: readonly SocketDoc[]
  }

  /** The Ozaco Manifest v1. */
  export interface Manifest {
    readonly manifest: 'ozaco/1'
    readonly name: string
    readonly version: string
    readonly instance: string
    readonly services: readonly ServiceDoc[]
    readonly errors: Readonly<Record<string, number>>

    /** every socket route, those without a service included. */
    readonly sockets: readonly SocketDoc[]
    readonly observe: { readonly console: string | null }
    readonly docs: { readonly path: string; readonly openapi: string }
  }
}
