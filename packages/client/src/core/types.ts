import type { Operation, Scope, Task } from 'std:effect'
import type { FetchDef } from 'std:fetch'
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
   * A pre-fetched OZACO MANIFEST v1 document. When absent, `GET <url><docsPath>/manifest` is
   * fetched lazily on first use; if that fails, addressing falls back to `POST /<resource>/<fn>`
   * and `/<resource>/_realtime`.
   */
  readonly manifest?: unknown
  /** Where the docs plugin is mounted. Default `/docs`. */
  readonly docsPath?: string | undefined
}

/** Called after EVERY applied realtime frame with the materialized rows and their version. */
export type WatchRows = (rows: readonly unknown[], version: number) => void

export interface WatchOptions {
  /** Called on server `error` frames and permanent transport failures for this watch. */
  readonly onError?: ((failure: Result.Failure<unknown>) => void) | undefined
}

/** Which way a realtime frame travelled. `sys` and `err` are engine notes, not wire frames. */
export type FrameDirection = 'in' | 'out' | 'sys' | 'err'

/** One observed realtime frame — the inspector's timeline entry. */
export interface FrameLog {
  readonly at: number
  readonly dir: FrameDirection
  readonly text: string
}

/** Observes every frame on a realtime link; returns a disposer. */
export type FrameTap = (frame: FrameLog) => void

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

/** Lifecycle of a shared realtime connection, as the inspector reports it. */
export type LinkStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed'

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
  status: LinkStatus
  /**
   * Someone holds this link OPEN independently of its watches. Typed `.watch()` callers let the
   * last stopped watch close the socket; a tool that opened the link explicitly owns it until it
   * calls `close()` — otherwise restarting a watch would drop the connection under it.
   */
  pinned: boolean
  /** Frame observers (the inspector's timeline); empty for plain typed clients. */
  readonly taps: Set<FrameTap>
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

/** Where a call goes: the manifest route, or the `POST /<resource>/<fn>` fallback. */
export interface CallAddress {
  readonly method: string
  readonly path: string
}

/** How the request body was framed. `multipart` is forced by any attachment. */
export type BodyKind = 'none' | 'json' | 'multipart'

/** Everything about the request that actually went on the wire. */
export interface PreparedRequest {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string | FormData | undefined
  readonly bodyKind: BodyKind
}

/** One attachment. Any attachment switches the request to `multipart/form-data`, with the
 * remaining args written as fields BEFORE the files (the edge folds leading fields into params). */
export interface RequestFile {
  readonly field: string
  readonly file: Blob
  /** Overrides `file.name` (a `File` carries its own). */
  readonly filename?: string | undefined
}

/**
 * One inspected round trip. Address it through the manifest (`resource` + `fn`) or pin the request
 * line yourself (`method` + `path`) — pinning wins, which is what a request workspace needs when
 * the user edits the URL by hand.
 */
export interface InspectInput {
  readonly resource?: string | undefined
  readonly fn?: string | undefined
  readonly method?: string | undefined
  readonly path?: string | undefined
  readonly args?: unknown
  readonly files?: readonly RequestFile[] | undefined
  /** Merged OVER the session headers and the bearer token. */
  readonly headers?: Record<string, string> | undefined
  readonly timeoutMs?: number | undefined
}

/** How the edge framed the response body, read from `content-type` only (the body stays intact). */
export type ResponseKind = 'json' | 'ndjson' | 'sse' | 'bytes' | 'text'

/**
 * An inspected response: full metadata, body UNREAD. `response` is the `std:fetch` response
 * (`.json()`, `.text()`, `.raw()` byte flow, `.native` platform escape hatch) — nothing here has
 * consumed it, so streaming bodies stay readable.
 */
export interface InspectResponse {
  readonly status: number
  readonly ok: boolean
  readonly statusText: string
  readonly headers: Headers
  /** The gateway's `x-request-id` echo. */
  readonly requestId: string | null
  readonly kind: ResponseKind
  /** Wall-clock milliseconds from dispatch to response headers. */
  readonly elapsedMs: number
  readonly response: FetchDef.Response
  /**
   * The platform `Response`, body untouched. Effect-land callers read through `response`
   * (`json()`, `text()`, `raw()`); plain-async callers — browser tooling — read through this.
   */
  readonly native: Response
  /** What was sent — the request pane renders this, no guessing. */
  readonly sent: PreparedRequest
}

/** A watch registered through a realtime link. */
export interface WatchHandle {
  readonly id: string
  readonly rows: () => readonly unknown[]
  readonly version: () => number
  readonly stop: () => Operation<void>
}

/** Which realtime endpoint to open: a manifest resource, or an explicit path (pinning wins). */
export interface RealtimeTarget {
  readonly resource?: string | undefined
  readonly path?: string | undefined
}

/** One untyped watch request — `fn` is the server-side function key, addressed by name. */
export interface RealtimeWatch {
  readonly fn: string
  readonly args?: unknown
  readonly onRows: WatchRows
  readonly options?: WatchOptions | undefined
}

/** Raw realtime access: lifecycle, frame timeline and untyped `fn`-addressed watches. */
export interface RealtimeLink {
  readonly path: string
  readonly status: () => LinkStatus
  /** Observe every frame in both directions; call the returned disposer to stop. */
  readonly tap: (observer: FrameTap) => () => void
  readonly watch: (input: RealtimeWatch) => Operation<WatchHandle>
  /** Drop every watch and close the socket. */
  readonly close: () => Operation<void>
}

/** The SSE flavor of a realtime service: `GET <realtime.path>/sse?fn=&args=&since=`. */
export interface SseInput {
  /** Realtime service resource name — resolves the path through the manifest. */
  readonly resource?: string | undefined
  /** Explicit SSE url path, overriding manifest resolution. */
  readonly path?: string | undefined
  readonly fn: string
  readonly args?: unknown
  readonly since?: number | undefined
  /** Each `data:` payload, decoded through the codec. */
  readonly onValue: (value: unknown) => void
  /** Payloads that are not decodable (raw text). */
  readonly onRaw?: ((data: string) => void) | undefined
  /** `:`-prefixed comment lines — the edge opens every stream with `: ok`. */
  readonly onComment?: ((comment: string) => void) | undefined
  readonly onError?: ((failure: Result.Failure<unknown>) => void) | undefined
  readonly onEnd?: (() => void) | undefined
}

export interface SseHandle {
  readonly url: string
  readonly stop: () => Operation<void>
}

/**
 * The inspector session: everything `createClient`'s typed proxy hides. Same addressing, same
 * realtime engine, same auth — but responses arrive whole (status, headers, timing, unread body),
 * requests take attachments, and realtime frames are observable.
 */
export interface ManifestOptions {
  /** Drop the cached document and re-read `GET <url><docsPath>/manifest`. */
  readonly refresh?: boolean | undefined
}

export interface ClientSession {
  /** The resolved manifest (`null` when the server serves none), cached after the first read. */
  readonly manifest: (options?: ManifestOptions) => Operation<ManifestDoc | null>
  readonly address: (resource: string, fn: string) => Operation<CallAddress>
  readonly request: (input: InspectInput) => Operation<InspectResponse>
  /** Open (or join) the shared realtime link of a resource (or of an explicit path). */
  readonly realtime: (target: RealtimeTarget) => Operation<RealtimeLink>
  readonly sse: (input: SseInput) => Operation<SseHandle>
}

/**
 * An in-flight async request.
 *
 * `done` settles as soon as the response HEADERS land — the body is still unread, which is the
 * whole point. `std:fetch` binds its abort signal to the request's scope, so that body stays
 * readable only while this handle is open: call `close()` once you are done reading (or no longer
 * care), and `cancel()` to abort mid-flight.
 */
export interface RequestHandle {
  readonly done: Promise<InspectResponse>
  /** Release the request — REQUIRED after reading (or abandoning) the body. */
  readonly close: () => Promise<void>
  /** Abort the request where it stands; `done` settles with the halt. */
  readonly cancel: () => Promise<void>
}

/** Promise-facing watch handle (the `connectSession` facade). */
export interface AsyncWatchHandle {
  readonly id: string
  readonly rows: () => readonly unknown[]
  readonly version: () => number
  readonly stop: () => Promise<void>
}

export interface AsyncRealtimeLink {
  readonly path: string
  readonly status: () => LinkStatus
  readonly tap: (observer: FrameTap) => () => void
  readonly watch: (input: RealtimeWatch) => Promise<AsyncWatchHandle>
  readonly close: () => Promise<void>
}

export interface AsyncSseHandle {
  readonly url: string
  readonly stop: () => Promise<void>
}

/** {@link ClientSession} with Promises instead of Operations — what browser tooling consumes. */
export interface AsyncSession {
  readonly manifest: (options?: ManifestOptions) => Promise<ManifestDoc | null>
  readonly address: (resource: string, fn: string) => Promise<CallAddress>
  /** Returns a handle instead of a bare promise so the caller can cancel mid-flight. */
  readonly request: (input: InspectInput) => RequestHandle
  readonly realtime: (target: RealtimeTarget) => Promise<AsyncRealtimeLink>
  readonly sse: (input: SseInput) => Promise<AsyncSseHandle>
}

/** What `connectSession` resolves with: the async session plus its lifecycle closer. */
export interface ConnectedSession {
  readonly session: AsyncSession
  /** Tear down the private scope: every watch stops, every socket and stream closes. */
  readonly close: () => Promise<void>
}
