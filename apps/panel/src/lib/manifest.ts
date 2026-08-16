/**
 * OZACO MANIFEST v1 — hand-written mirror of `packages/server/src/docs/manifest.ts`'s
 * `manifestSchema` (no zod dependency in the panel bundle) plus indexing helpers for the UI.
 * The document is served by the docs plugin at `GET <docsPath>/manifest` (default `/docs`).
 */

/** JSON Schema documents travel as opaque objects; `{ declared: true }` marks non-zod schemas. */
export type SchemaDoc = Record<string, unknown>

export type FnKind = 'query' | 'mutation' | 'action' | 'stream'

export type Channel = 'value' | 'stream' | 'chunks' | 'parts' | 'socket'

export interface RouteDoc {
  readonly method: string
  readonly path: string
  readonly sse?: boolean
}

export interface StatusEntry {
  readonly status: number
}

export interface FunctionDoc {
  readonly kind: FnKind
  readonly title?: string
  readonly description?: string
  readonly route?: RouteDoc
  readonly args?: SchemaDoc
  readonly returns?: SchemaDoc
  readonly channels: {
    readonly input: readonly Channel[]
    readonly output: readonly Channel[]
  }
  readonly errors?: Readonly<Record<string, StatusEntry>>
  readonly tags?: readonly string[]
}

export interface RealtimeDoc {
  readonly path: string
  /** The service also serves the SSE flavor at `GET <path>/sse?fn=&args=&since=`. */
  readonly sse?: true
  readonly client: { readonly watch: SchemaDoc; readonly unwatch: SchemaDoc }
  readonly server: {
    readonly sync: SchemaDoc
    readonly delta: SchemaDoc
    readonly reset: SchemaDoc
    readonly error: SchemaDoc
  }
}

export interface ServiceDoc {
  readonly version: string
  readonly description?: string
  readonly prefix: string
  readonly functions: Readonly<Record<string, FunctionDoc>>
  readonly events?: Readonly<Record<string, SchemaDoc>>
  readonly realtime?: RealtimeDoc
}

export interface Manifest {
  readonly ozaco: '1.0'
  readonly app: {
    readonly title: string
    readonly version: string
    readonly description?: string
  }
  readonly auth?: { readonly bearer: true }
  readonly errors: Readonly<Record<string, StatusEntry>>
  readonly services: Readonly<Record<string, ServiceDoc>>
}

export const DEFAULT_DOCS_PATH = '/docs'

/** Fetch the manifest from the real docs mount (`GET <base><docsPath>/manifest`). */
export const fetchManifest = async (
  base: string,
  docsPath: string = DEFAULT_DOCS_PATH,
): Promise<Manifest> => {
  const response = await fetch(`${base}${docsPath}/manifest`, {
    headers: { accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`manifest request failed: ${response.status} ${response.statusText}`)
  }

  return (await response.json()) as Manifest
}

/** One function of one service, flattened for the sidebar/detail views. */
export interface FnEntry {
  /** `<service>.<key>` — the stable selection id. */
  readonly id: string
  readonly service: string
  readonly key: string
  readonly kind: FnKind
  readonly title: string | undefined
  readonly description: string | undefined
  readonly route: RouteDoc | undefined
  readonly args: SchemaDoc | undefined
  readonly returns: SchemaDoc | undefined
  readonly channels: FunctionDoc['channels']
  readonly errors: Readonly<Record<string, StatusEntry>>
  readonly tags: readonly string[]
  /** The owning service's mount prefix. */
  readonly prefix: string
  /** The owning service's realtime block, when it has one. */
  readonly realtime: RealtimeDoc | undefined
}

/** Flatten every service function into an ordered list (manifest object order preserved). */
export const indexManifest = (manifest: Manifest): FnEntry[] => {
  const entries: FnEntry[] = []

  for (const [service, doc] of Object.entries(manifest.services)) {
    for (const [key, fn] of Object.entries(doc.functions)) {
      entries.push({
        id: `${service}.${key}`,
        service,
        key,
        kind: fn.kind,
        title: fn.title,
        description: fn.description,
        route: fn.route,
        args: fn.args,
        returns: fn.returns,
        channels: fn.channels,
        errors: fn.errors ?? {},
        tags: fn.tags ?? [],
        prefix: doc.prefix,
        realtime: doc.realtime,
      })
    }
  }

  return entries
}

export const findFn = (entries: readonly FnEntry[], id: string): FnEntry | undefined =>
  entries.find(entry => entry.id === id)

export interface RealtimeService {
  readonly service: string
  readonly prefix: string
  readonly realtime: RealtimeDoc
  /** Function keys of the service — candidates for the watch `fn` field. */
  readonly functions: readonly string[]
}

/** Every service exposing a realtime channel, for the live watch view. */
export const realtimeServices = (manifest: Manifest): RealtimeService[] => {
  const services: RealtimeService[] = []

  for (const [service, doc] of Object.entries(manifest.services)) {
    if (doc.realtime) {
      services.push({
        service,
        prefix: doc.prefix,
        realtime: doc.realtime,
        functions: Object.keys(doc.functions),
      })
    }
  }

  return services
}

/** Whether an entry accepts multipart uploads (`parts` on the input wire). */
export const acceptsFiles = (entry: FnEntry): boolean => entry.channels.input.includes('parts')

/** The SSE flavor path of a realtime block (`GET <path>/sse?fn=&args=&since=`). */
export const ssePathOf = (realtime: RealtimeDoc): string => `${realtime.path}/sse`
