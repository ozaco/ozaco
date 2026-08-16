import type { Operation, Scope, Task } from 'std:effect'
import type { Result } from 'std:result'

/**
 * Structural mirror of the OZACO MANIFEST v1 wire document (`@ozaco/server`'s `manifestSchema`).
 * Declared locally so `@ozaco/client` ships without a server dependency — the manifest travels as
 * plain JSON and only its SHAPE matters here.
 */
export interface ManifestRouteDoc {
  readonly method: string
  readonly path: string
  readonly sse?: boolean | undefined
}

export interface ManifestFunctionDoc {
  readonly kind: 'query' | 'mutation' | 'action' | 'stream'
  readonly title?: string | undefined
  readonly description?: string | undefined
  readonly route?: ManifestRouteDoc | undefined
  /** A JSON Schema document, or `{ declared: true }` for non-representable schemas. */
  readonly args?: Record<string, unknown> | undefined
  readonly returns?: Record<string, unknown> | undefined
  readonly channels?:
    | { readonly input: readonly string[]; readonly output: readonly string[] }
    | undefined
  readonly errors?: Record<string, { readonly status: number }> | undefined
  readonly tags?: readonly string[] | undefined
}

export interface ManifestRealtimeDoc {
  readonly path: string
  /** The service also serves the SSE flavor at `GET <path>/sse?fn=&args=&since=`. */
  readonly sse?: true | undefined
  readonly client?: Record<string, Record<string, unknown>> | undefined
  readonly server?: Record<string, Record<string, unknown>> | undefined
}

export interface ManifestServiceDoc {
  readonly version: string
  readonly description?: string | undefined
  readonly prefix: string
  readonly functions: Record<string, ManifestFunctionDoc>
  readonly events?: Record<string, Record<string, unknown>> | undefined
  readonly realtime?: ManifestRealtimeDoc | undefined
}

export interface ManifestDoc {
  readonly ozaco: '1.0'
  readonly app: {
    readonly title: string
    readonly version: string
    readonly description?: string | undefined
  }
  readonly auth?: { readonly bearer: true } | undefined
  readonly errors: Record<string, { readonly status: number }>
  readonly services: Record<string, ManifestServiceDoc>
}

export interface ClientOptions {
  /** Base URL of the server (e.g. `http://localhost:3000`). */
  readonly url: string
  /**
   * Bearer token — a value or a per-call resolver. Sent as `authorization: Bearer <token>` on
   * HTTP calls and appended as `?token=` on realtime sockets (browsers cannot set WS headers;
   * the gateway promotes the query param back into the authorization header).
   */
  readonly token?: string | (() => string | undefined) | undefined
  /** Extra headers sent on every HTTP call (merged under the authorization header). */
  readonly headers?: Record<string, string> | undefined
  /**
   * A pre-fetched OZACO MANIFEST v1 document. When absent, `GET <url>/docs/manifest` is fetched
   * lazily on first use; if that fails, addressing falls back to `POST /<resource>/<fn>` and
   * `/<resource>/_realtime`.
   */
  readonly manifest?: unknown
}

/** Called after EVERY applied realtime frame with the materialized rows and their version. */
export type WatchRows = (rows: readonly unknown[], version: number) => void

export interface WatchOptions {
  /** Called on server `error` frames and permanent transport failures for this watch. */
  readonly onError?: ((failure: Result.Failure<unknown>) => void) | undefined
}

/** Stop the watch: sends `unwatch`, drops local state, closes the shared socket if last. */
export type WatchStop = () => Operation<void>

/** One callable api fn: invoke for a request/response round trip, `.watch` for realtime rows. */
export interface ClientFn<TParams = unknown, TResult = unknown> {
  (args: TParams): Operation<TResult>
  watch(args: TParams, onRows: WatchRows, options?: WatchOptions): Operation<WatchStop>
}

/** Maps a wizard resource's fns (`Action`-shaped callables) to client fns; `$wizard` is dropped. */
export type ClientResource<TResource> = {
  readonly [F in Exclude<keyof TResource, '$wizard'>]: TResource[F] extends (
    params: infer TParams,
  ) => Operation<infer TResult>
    ? ClientFn<TParams, TResult>
    : never
}

/**
 * The typed client for a wizard api tree — import `type Api` from the server package (or generate
 * it with `@ozaco/client/codegen`) and pass it as the type parameter of `createClient`.
 */
export type Client<TApi> = { readonly [R in keyof TApi]: ClientResource<TApi[R]> }

/** Promise-facing fn (the `connectClient` facade): same shape, Promises instead of Operations. */
export interface AsyncClientFn<TParams = unknown, TResult = unknown> {
  (args: TParams): Promise<TResult>
  watch(args: TParams, onRows: WatchRows, options?: WatchOptions): Promise<() => Promise<void>>
}

export type AsyncClientResource<TResource> = {
  readonly [F in Exclude<keyof TResource, '$wizard'>]: TResource[F] extends (
    params: infer TParams,
  ) => Operation<infer TResult>
    ? AsyncClientFn<TParams, TResult>
    : never
}

export type AsyncClient<TApi> = { readonly [R in keyof TApi]: AsyncClientResource<TApi[R]> }

/** What `connectClient` resolves with: the Promise-facing client plus its lifecycle closer. */
export interface ConnectedClient<TApi> {
  readonly client: AsyncClient<TApi>
  /** Tear down the client's private scope: every watch stops and every socket closes. */
  readonly close: () => Promise<void>
}

/** One active realtime subscription (internal). */
export interface WatchEntry {
  readonly id: string
  readonly fn: string
  readonly args: unknown
  readonly onRows: WatchRows
  readonly onError?: ((failure: Result.Failure<unknown>) => void) | undefined
  /** Local row map keyed by `row._id` (synthetic keys when rows are unkeyed). */
  rows: Map<string, unknown>
  /** Whether the rows are `_id`-keyed (delta frames apply per row) or replace-all only. */
  keyed: boolean
  /** Last observed `version` (`-1` before the first sync — never sent as `since`). */
  version: number
}

/** One shared realtime connection per resource realtime path (internal). */
export interface ResourceLink {
  readonly path: string
  readonly entries: Map<string, WatchEntry>
  /** The pump task on the CLIENT scope — halting it closes the shared socket. */
  task: Task<Result<void>> | undefined
  send: ((text: string) => Operation<void>) | undefined
  /** Resolves once the connection is dialed (successfully or not — check `failure`). */
  readonly ready: Operation<void>
  readonly markReady: () => void
  failure: Result.Failure<unknown> | undefined
}

/** The shared client state every fn closes over (internal). */
export interface ClientState {
  readonly options: ClientOptions
  /** The scope `createClient` was called in — realtime pumps and shared sockets live here. */
  readonly scope: Scope
  /** `undefined` = not resolved yet · `null` = unavailable (fallback addressing) · doc = in use. */
  manifest: ManifestDoc | null | undefined
  readonly links: Map<string, ResourceLink>
}
