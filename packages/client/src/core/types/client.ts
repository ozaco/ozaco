import type { ServiceDef } from 'server:core'
import type { Flow, Future, FutureFlow, Operation, Scope } from 'std:effect'
import type { AnyType, StandardSchemaV1 } from 'std:shared'
import type { WsDef } from 'std:ws'

import type { ManifestDef } from './manifest'

/**
 * The client surface. `createClient<Api>()` with `Api = typeof server.api` (the server's typed
 * refs) gives `client.<service>.<action>(input)` end to end — no codegen needed; `@ozaco/client/
 * codegen` still emits a standalone `Api` type from a manifest for consumers without the server
 * sources.
 */
export namespace ClientDef {
  export interface Options {
    /** Base URL of the server (`http://localhost:3000`). */
    readonly url: string

    /** A path every route is mounted under on this server (`'/api'` when a proxy puts the node
     * there): prepended to the action routes, the manifest path and the realtime sockets. */
    readonly prefix?: string | undefined

    /** Bearer token — a value or a per-call resolver (sent as `authorization`, and as `?token=`
     * on sockets). */
    readonly token?: string | (() => string | undefined) | undefined
    readonly headers?: Readonly<Record<string, string>> | undefined

    /** A pre-fetched manifest; otherwise `GET <url><docsPath>/manifest` on first use. */
    readonly manifest?: ManifestDef.Manifest | undefined

    /** Where the docs plugin lives. Default `/docs`. */
    readonly docsPath?: string | undefined

    /** Per-call deadline. Default 30 000. */
    readonly timeoutMs?: number | undefined

    /** The realtime route suffix of resources. Default `/_realtime`. */
    readonly realtimePath?: string | undefined

    /** `fetch` to use (tests, custom agents). Default: the global. */
    readonly fetch?: typeof fetch | undefined

    /** What `$text` answers for a failure, by one of its string causes or by its tag
     * (`{ 'users:last-admin': 'The last admin stays.', 'client.network': 'Offline.' }`). */
    readonly messages?: Readonly<Record<string, string>> | undefined

    /** The session the client authenticates with (see {@link SessionOptions}): where the tokens
     * persist and how the access token is renewed. Without it `$session` is memory-only. */
    readonly session?: SessionOptions | undefined
  }

  // --- the session -----------------------------------------------------------------------------

  /** Tokens as the server's auth issues them (`login` / `refresh`). */
  export interface Tokens {
    readonly accessToken: string
    readonly refreshToken?: string | undefined

    /** epoch ms; read off the access token's `exp` when it is a JWT, this otherwise. */
    readonly expiresAt?: number | undefined
  }

  /** Where a session keeps its tokens across page loads — `localStorage`, or anything shaped
   * like it. Every read goes to it, so a sign-in in another tab is picked up. */
  export interface TokenStorage {
    getItem(key: string): string | null
    setItem(key: string, value: string): void
    removeItem(key: string): void
  }

  export interface SessionOptions {
    readonly storage?: TokenStorage | undefined

    /** the storage keys. Default `ozaco:access` / `ozaco:refresh`. */
    readonly keys?: { readonly access?: string; readonly refresh?: string } | undefined

    /** Exchange the refresh token for a fresh pair — the server's refresh action through the
     * handle: `(client, refreshToken) => client.auth.refresh({ refreshToken })`. Before a call
     * made within `skewMs` of the access token's expiry the client renews first (one renewal is
     * shared by every caller); a refresh the server REFUSES ends the session (the tokens are
     * cleared), one that fails on the network leaves it alone. */
    readonly refresh?:
      | ((client: Handle<AnyType>, refreshToken: string) => Future<Tokens>)
      | undefined

    /** how long before `exp` a token counts as expiring. Default 60 000. */
    readonly skewMs?: number | undefined

    /** keep renewing in the background while the client lives — a tab whose only live link is a
     * socket makes no call to renew on. Default on when `refresh` is given. */
    readonly keepAlive?: boolean | undefined
  }

  export type SessionStatus = 'active' | 'anonymous'

  /** `client.$session`: the tokens the client calls with. */
  export interface Session {
    /** the access token (the storage's, else the `token` option's until the first `set`). */
    token(): string | null
    refreshToken(): string | null

    /** the access token's expiry in epoch ms — `0` when unknown. */
    expiresAt(): number
    status(): SessionStatus

    /** the access token's decoded JWT payload (`roles`, `permissions`, `email`, … — whatever the
     * server put there), `null` without a readable JWT. Unverified: what the UI shows and gates
     * on, never what the server trusts. Re-read on every call, so it follows `set`/`renew`. */
    claims<T extends Record<string, unknown> = Record<string, unknown>>(): T | null
    set(tokens: Tokens): void
    clear(): void

    /** renew now (single-flight): `true` when a fresh pair is in place; `false` when there is
     * nothing to renew, or the server refused (the session is then cleared). */
    renew(): Future<boolean>

    /** be told when the session becomes active or anonymous; answers the unsubscribe. */
    subscribe(listener: (status: SessionStatus) => void): () => void
  }

  // --- collections ---------------------------------------------------------------------------

  export interface CollectionOptions {
    readonly filter?: Filter | undefined

    /** the order rows are kept in (the server's keyset order). Default `_created_at`, newest
     * first. */
    readonly order?: { readonly field: string; readonly direction?: 'asc' | 'desc' } | undefined

    /** the page size of `load` / `more` and the live window. Default 100. */
    readonly limit?: number | undefined

    /** the list action's key when it is not `list`. */
    readonly action?: string | undefined

    /** the realtime route when it is not the manifest's. */
    readonly path?: string | undefined
  }

  /**
   * `client.$collection(resource, options)`: the rows of a resource as ONE list — the page `load`
   * fetched, the pages `more` walked back to, and the live frames of the watch `load` opened,
   * merged by `_id` and kept in `order` (a frame's `removed` drops rows). A store keeps it and
   * renders `rows()`; `changes` says when they moved.
   */
  export interface Collection<TDoc = unknown> {
    rows(): readonly TDoc[]

    /** the first page, replacing what was there, and (once) the live watch. */
    load(): Future<readonly TDoc[]>

    /** the page after the last one; `false` when there was none to fetch. */
    more(): Future<boolean>
    hasMore(): boolean

    /** every new value of `rows()` (one consumer). */
    readonly changes: FutureFlow<readonly TDoc[]>

    /** end the watch; `rows()` keeps what it had. */
    stop(): void
  }

  export interface CallOptions {
    readonly headers?: Readonly<Record<string, string>> | undefined
    readonly timeoutMs?: number | undefined

    /** request id to send (one is minted otherwise). */
    readonly requestId?: string | undefined

    /** Abort the AWAITED call (and whatever stream it opened). A `yield*`ed call needs no
     * signal — it is cancelled with the caller's task. */
    readonly signal?: AbortSignal | undefined
  }

  /** An action by name: `'demo.echo'` or `{ service, action }` (a server ref works). */
  export type Target = string | { readonly service: string; readonly action: string }

  /** What a call resolves besides the value. */
  export interface Meta {
    readonly requestId: string
    readonly status: number
    readonly brand: string | null

    /** the trace the call belongs to: the server's `traceresponse`, else the call's own CLIENT
     * span's; `null` when neither exists (nothing traced, no response header). */
    readonly traceId: string | null
  }

  /** The pager of a WINDOWED watch: keyset cursors + the set's total, as of the frame token. */
  export interface WindowInfo {
    readonly next: string | null
    readonly prev: string | null
    readonly total: number
  }

  /** A watch frame from a resource's realtime route. Windowed watches carry `page`; `notify`
   * says the SET changed around an untouched window (another client's write moved the
   * range/total) — same token space as every frame. */
  export type WatchFrame<TRow = unknown> =
    | {
        readonly t: 'sync'
        readonly rows: readonly TRow[]
        readonly token: string
        readonly page?: WindowInfo | undefined
      }
    | {
        readonly t: 'delta'
        readonly added: readonly TRow[]
        readonly changed: readonly TRow[]
        readonly removed: readonly string[]
        readonly token: string
        readonly page?: WindowInfo | undefined
      }
    | { readonly t: 'notify'; readonly token: string; readonly page: WindowInfo }

  export interface WatchOptions {
    readonly filter?: unknown
    readonly order?: { readonly field: string; readonly direction?: 'asc' | 'desc' } | undefined

    /** a WINDOWED watch: subscribe one keyset page of this size (`cursor` picks the page,
     * `back` pages backward from a `prev` cursor). `0` — the manifest default — is the start
     * of the set; a bare row `_id` starts the window AT that row. */
    readonly limit?: number | undefined
    readonly cursor?: string | number | undefined
    readonly back?: boolean | undefined

    /** resume from a token (the last frame's) — a reconnect does this by itself. */
    readonly since?: string | undefined

    /** the socket's route when it is not where the manifest (or `/<resource>/_realtime`)
     * says — e.g. a `crud.realtime` entry mounted under another key. */
    readonly path?: string | undefined
  }

  /** The materialized rows of a watch, kept current from the frames. */
  export interface Materialized<TRow = unknown> {
    readonly rows: readonly TRow[]
    readonly token: string

    /** present on windowed watches. */
    readonly page?: WindowInfo | undefined
  }

  /** A watch's frame feed: `turn(cursor)` re-sends the watch over the SAME socket and id
   * (windowed watches only — the server replaces the window and answers with a fresh sync). */
  export type WatchFeed<TRow = unknown> = FutureFlow<WatchFrame<TRow>> & {
    turn(cursor: string | null, back?: boolean): void
  }

  /** A windowed subscription with its pager: `next()`/`prev()` turn THIS subscriber's page
   * (a fresh `sync` of the new window arrives on `rows`); other subscribers are untouched. */
  export interface Window<TRow = unknown> {
    readonly rows: FutureFlow<Materialized<TRow>>

    /** the latest pager info (`null` until the first sync lands). */
    page(): WindowInfo | null
    next(): void
    prev(): void

    /** jump to a cursor (`null` = the first page; `back` pages backward from a prev cursor). */
    turn(cursor: string | null, back?: boolean): void
  }

  // --- the resource wire shapes (what `crud` serves) ----------------------------------------

  /** The system fields every stored row carries. */
  export interface System {
    readonly _id: string
    readonly _created_at: number
    readonly _updated_at: number
    readonly _version: string
  }

  /** A resource's `list` page. */
  export interface Page<TDoc = unknown> {
    readonly data: readonly TDoc[]
    readonly nextCursor: string | null
    readonly prevCursor: string | null
    readonly token: string
  }

  /** A resource's `list` input. */
  export interface ListInput {
    readonly filter?: Filter | undefined
    readonly order?: string | undefined
    readonly direction?: 'asc' | 'desc' | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  }

  export type FilterValue = string | number | boolean | null

  /** A field, or a path into a `json` field (`['payload', 'workspace']`). */
  export type FieldRef = string | readonly [string, ...(string | number)[]]

  /** A filter as the resource routes read it — what `where.*` builds (the db's own algebra, on
   * the wire). */
  export type Filter =
    | {
        readonly op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
        readonly field: string
        readonly path?: readonly (string | number)[] | undefined
        readonly value: FilterValue
      }
    | {
        readonly op: 'in' | 'not-in'
        readonly field: string
        readonly path?: readonly (string | number)[] | undefined
        readonly value: readonly FilterValue[]
      }
    | {
        readonly op: 'like'
        readonly field: string
        readonly path?: readonly (string | number)[] | undefined
        readonly pattern: string
        readonly insensitive?: boolean | undefined
      }
    | {
        readonly op: 'is-null' | 'not-null'
        readonly field: string
        readonly path?: readonly (string | number)[] | undefined
      }
    | { readonly op: 'and' | 'or'; readonly filters: readonly Filter[] }
    | { readonly op: 'not'; readonly filter: Filter }

  // --- typing from the server's api (or a generated `Api`) --------------------------------------

  /** The server's `Ref<A>` shape, structurally: the action rides on a phantom symbol key. */
  export interface Ref {
    readonly service: string
    readonly action: string
  }

  /** A generated (codegen) action entry: plain input/output types. */
  export interface Generated<TInput = unknown, TOutput = unknown> {
    readonly kind: 'query' | 'mutation' | 'action' | 'stream'
    readonly input: TInput
    readonly output: TOutput
  }

  /** A branded stream as the server types it (`ReadableStream & { [brand]: B }`), read
   * structurally: the brand is the one non-stream member. */
  export type BrandOf<T> =
    T extends ReadableStream<AnyType>
      ? Exclude<T[keyof T], ReadableStream<AnyType>[keyof ReadableStream<AnyType>]>
      : never

  /** What a call returns for an output declaration, by brand: `ndjson`/`sse` (a Flow on the
   * server) → `FutureFlow` (`yield*` OR `for await`), `text` → `string`, `bytes:*` →
   * `ReadableStream<Uint8Array>`, values as-is. */
  export type Decoded<TOutput> = 0 extends 1 & TOutput
    ? unknown
    : [BrandOf<TOutput>] extends [never]
      ? TOutput extends ReadableStream<infer T>
        ? T extends Uint8Array
          ? ReadableStream<Uint8Array>
          : FutureFlow<T>
        : TOutput
      : BrandOf<TOutput> extends 'text'
        ? string
        : BrandOf<TOutput> extends `bytes:${string}`
          ? ReadableStream<Uint8Array>
          : Extract<TOutput, Flow<AnyType, AnyType>> extends Flow<infer T, AnyType>
            ? FutureFlow<T>
            : ReadableStream<Uint8Array>

  /** The phantom action of a server ref: the one non-string member. */
  export type ActionOf<R> = Exclude<R[keyof R], string | undefined>
  export type HandlerInput<A> = A extends { handler: (call: infer C) => AnyType }
    ? C extends { input: infer I }
      ? I
      : unknown
    : unknown

  /** The DECLARED input as the CLIENT sends it: a value schema is taken by its INPUT side —
   * a field with a `.default()` stays OPTIONAL on the wire (the server applies the default);
   * stream/parts declarations keep the handler's own input shape. */
  export type DeclaredInput<A> =
    A extends ServiceDef.Action<infer I, AnyType>
      ? [I] extends [StandardSchemaV1]
        ? StandardSchemaV1.InferInput<I>
        : HandlerInput<A>
      : HandlerInput<A>
  export type HandlerOutput<A> = A extends { handler: (call: AnyType) => Operation<infer O> }
    ? O
    : unknown

  /** What a stream input accepts on the client side. */
  export type SendStream = ReadableStream<Uint8Array> | Blob | Uint8Array | string

  /** The server's input type as the client takes it: a branded stream becomes `SendStream`,
   * parts become `{ fields, streams: Record<name, SendStream> }`, values stay as they are. */
  export type ClientInput<I> = 0 extends 1 & I
    ? unknown
    : [BrandOf<I>] extends [never]
      ? I extends { readonly fields: infer F; readonly streams: infer S }
        ? { readonly fields: F; readonly streams: { readonly [K in keyof S]: SendStream } }
        : I
      : SendStream

  export type InputOf<R> = ClientInput<
    R extends Generated<infer I, AnyType> ? I : DeclaredInput<ActionOf<R>>
  >
  export type OutputOf<R> = R extends Generated<AnyType, infer O> ? O : HandlerOutput<ActionOf<R>>

  /** The input argument is optional when the action takes none (`undefined` / `unknown`) —
   * or when every field of it is optional (`{}` satisfies it). */
  export type CallArgs<I> = undefined extends I
    ? [input?: I, options?: CallOptions]
    : unknown extends I
      ? [input?: I, options?: CallOptions]
      : Record<never, never> extends I
        ? [input?: I, options?: CallOptions]
        : [input: I, options?: CallOptions]

  /** Every call is a {@link Future}: `yield*` it (inline, the caller's task — a failure raises)
   * OR `await` it (a detached job of the client's scope — resolves the `Result`, the failure as
   * a value, never rejects). Nothing is given up on either side. */
  export type Callable<R> = (...args: CallArgs<InputOf<R>>) => Future<Decoded<OutputOf<R>>>

  export type ClientOf<TApi> = {
    readonly [S in keyof TApi]: {
      readonly [K in keyof TApi[S]]: Callable<TApi[S][K]>
    }
  }

  export type Handle<TApi> = ClientOf<TApi> & Statics

  /** What {@link connectClient} resolves: the same handle plus the session teardown. Its
   * `$scope` is the session scope — `client.$scope.run(function* () { … })` runs an operation
   * where the client's contexts live, so inline `yield*` calls work there. */
  export type ConnectedHandle<TApi> = Handle<TApi> & {
    /** Tear the connection down: every open stream and socket dies with the scope. */
    readonly $close: () => Promise<void>
  }

  /** What `lazyClient` answers: a {@link ConnectedHandle} usable AT ONCE — every call, watch
   * and collection made on it waits for the client (manifest, plugins) by itself; `$session`
   * and `$scope` are real from the start, `$ready` resolves the handle once it is. */
  export type LazyHandle<TApi> = ConnectedHandle<TApi> & {
    readonly $ready: Promise<ConnectedHandle<TApi>>
  }

  /** The untyped half of a handle (the same on every client). */
  export interface Statics {
    /** call by name (untyped). */
    readonly $call: (target: Target, input?: unknown, options?: CallOptions) => Future<unknown>

    /** like `$call`, resolving `{ value, meta }`. */
    readonly $callWithMeta: (
      target: Target,
      input?: unknown,
      options?: CallOptions,
    ) => Future<{ readonly value: unknown; readonly meta: Meta }>

    /** the manifest (fetched on first use). */
    readonly $manifest: () => Future<ManifestDef.Manifest>

    /** a resource's realtime watch as frames (reconnects resume with `since`); windowed
     * watches page with `turn(cursor)` — same socket, same id. */
    readonly $watch: <TRow = unknown>(resource: string, options?: WatchOptions) => WatchFeed<TRow>

    /** `$watch` materialized into the current rows. */
    readonly $rows: <TRow = unknown>(
      resource: string,
      options?: WatchOptions,
    ) => FutureFlow<Materialized<TRow>>

    /** A WINDOWED watch with its pager (`options.limit` required to page). */
    readonly $window: <TRow = unknown>(resource: string, options?: WatchOptions) => Window<TRow>

    /** the last request id a call received. */
    readonly $lastRequestId: () => string | null

    /** the trace id of the last call's reply (its `traceresponse`, else the call's own CLIENT
     * span's) — what to look the call up by in Tempo / OpenObserve / the observe console. */
    readonly $lastTraceId: () => string | null

    /** The scope the client lives in (its plugins — IO, codec, ws — are installed there). Run an
     * operation in it (`$scope.run(...)`) to `yield*` calls from a task that has none of those
     * contexts itself; its teardown ends every open stream and socket. */
    readonly $scope: Scope

    /** Replace the bearer token from here on (`null` clears it; the option resolver is the
     * fallback until the first set) — `$session.set({ accessToken })` / `$session.clear()`. */
    readonly $setToken: (token: string | null) => void

    /** the session the client calls with — see {@link Session}. */
    readonly $session: Session

    /** the realtime sockets' state — see {@link Realtime}. */
    readonly $realtime: Realtime

    /** a resource's rows as one live list — see {@link Collection}. */
    readonly $collection: <TDoc extends { readonly _id: string } = { readonly _id: string }>(
      resource: string,
      options?: CollectionOptions,
    ) => Collection<TDoc>

    /** The text to show for a failure (a rejected call, a failed Result): the first of its string
     * causes `options.messages` names, else its tag's entry, else `fallback`, else its message. */
    readonly $text: (failure: unknown, fallback?: string) => string
  }

  export interface Context {
    readonly options: Options
    manifest: ManifestDef.Manifest | null
    lastRequestId: string | null
    lastTraceId: string | null

    /** the realtime sockets alive right now (one per watch) — what `$realtime` reads. */
    readonly sockets: Set<WsDef.Connection>
    readonly realtime: {
      status: RealtimeStatus
      /** watches that ended because their socket could not be reopened. */
      lost: number
      readonly listeners: Set<(status: RealtimeStatus) => void>
    }
  }

  /** `client.$realtime.status()`: `idle` (no watch open), `open` (a socket is up),
   * `reconnecting` (every socket is between generations — the ws client is redialing),
   * `down` (a watch gave up: its reconnect budget ran out and nothing else is open). */
  export type RealtimeStatus = 'idle' | 'open' | 'reconnecting' | 'down'

  /** The realtime connection state, for a UI that must know when its live data is stale — see
   * {@link RealtimeStatus}; `subscribe` is told on every change (polled while a watch lives). */
  export interface Realtime {
    status(): RealtimeStatus
    subscribe(listener: (status: RealtimeStatus) => void): () => void
  }
}
