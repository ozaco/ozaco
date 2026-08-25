/**
 * Structural mirror of the OZACO MANIFEST v1 (`@ozaco/server`'s docs plugin). Declared locally so
 * the client ships without a server dependency — the manifest is plain JSON; only its SHAPE
 * matters here.
 */
export namespace ManifestDef {
  export type Kind = 'query' | 'mutation' | 'action' | 'stream'

  export interface Plane {
    readonly plane: 'none' | 'value' | 'stream' | 'parts'
    readonly brand: string | null
    readonly contentType: string | null
    readonly schema?: Record<string, unknown> | null | undefined
    readonly streams?: Readonly<Record<string, string>> | undefined
  }

  export interface Action {
    readonly id: string
    readonly service: string
    readonly action: string
    readonly kind: Kind
    readonly title?: string | undefined
    readonly description?: string | undefined
    readonly route: { readonly method: string; readonly path: string }
    readonly input: Plane
    readonly output: Plane
    readonly errors: Readonly<Record<string, number>>
    readonly tags: readonly string[]
    readonly options: Readonly<Record<string, unknown>>
  }

  export interface Socket {
    readonly path: string
    readonly service: string | null
    readonly protocol: string | null
    readonly description: string | null

    /** opening-frame defaults (e.g. `{ cursor: 0 }` on realtime — start of the set). */
    readonly defaults?: Readonly<Record<string, unknown>> | null | undefined
  }

  export interface Service {
    readonly name: string
    readonly version: string
    readonly description?: string | undefined
    readonly actions: readonly Action[]
    readonly sockets?: readonly Socket[] | undefined
  }

  export interface Manifest {
    readonly manifest: 'ozaco/1'
    readonly name: string
    readonly version: string
    readonly instance: string
    readonly services: readonly Service[]
    readonly errors: Readonly<Record<string, number>>
    readonly sockets?: readonly Socket[] | undefined
    readonly observe?: { readonly console: string | null } | undefined
    readonly docs?: { readonly path: string; readonly openapi?: string | undefined } | undefined
  }
}
