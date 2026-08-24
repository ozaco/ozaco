import type { Flow, Future, FutureFlow, Operation } from 'std:effect'
import type { AnyType } from 'std:shared'

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
  }

  /** A delta-watch frame from a resource's realtime route. */
  export type WatchFrame<TRow = unknown> =
    | { readonly t: 'sync'; readonly rows: readonly TRow[]; readonly token: string }
    | {
        readonly t: 'delta'
        readonly added: readonly TRow[]
        readonly changed: readonly TRow[]
        readonly removed: readonly string[]
        readonly token: string
      }

  export interface WatchOptions {
    readonly filter?: unknown
    readonly order?: { readonly field: string; readonly direction?: 'asc' | 'desc' } | undefined

    /** resume from a token (the last frame's) — a reconnect does this by itself. */
    readonly since?: string | undefined
  }

  /** The materialized rows of a watch, kept current from the frames. */
  export interface Materialized<TRow = unknown> {
    readonly rows: readonly TRow[]
    readonly token: string
  }

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
    R extends Generated<infer I, AnyType> ? I : HandlerInput<ActionOf<R>>
  >
  export type OutputOf<R> = R extends Generated<AnyType, infer O> ? O : HandlerOutput<ActionOf<R>>

  /** The input argument is optional when the action takes none (`undefined` / `unknown`). */
  export type CallArgs<I> = undefined extends I
    ? [input?: I, options?: CallOptions]
    : unknown extends I
      ? [input?: I, options?: CallOptions]
      : [input: I, options?: CallOptions]

  /** Every call is a {@link Future}: `yield*` it (inline, the caller's task) OR `await` it
   * (a detached job of the client's scope; resolves a `Result` success, rejects with the
   * failure). Nothing is given up on either side. */
  export type Callable<R> = (...args: CallArgs<InputOf<R>>) => Future<Decoded<OutputOf<R>>>

  export type ClientOf<TApi> = {
    readonly [S in keyof TApi]: {
      readonly [K in keyof TApi[S]]: Callable<TApi[S][K]>
    }
  }

  export type Handle<TApi> = ClientOf<TApi> & Statics

  /** What {@link connectClient} resolves: the same handle plus the session teardown. */
  export type ConnectedHandle<TApi> = Handle<TApi> & {
    /** Tear the connection down: every open stream and socket dies with the scope. */
    readonly $close: () => Promise<void>
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

    /** a resource's realtime watch as frames (reconnects resume with `since`). */
    readonly $watch: <TRow = unknown>(
      resource: string,
      options?: WatchOptions,
    ) => FutureFlow<WatchFrame<TRow>>

    /** `$watch` materialized into the current rows. */
    readonly $rows: <TRow = unknown>(
      resource: string,
      options?: WatchOptions,
    ) => FutureFlow<Materialized<TRow>>

    /** the last request id a call received. */
    readonly $lastRequestId: () => string | null

    /** Replace the bearer token from here on (`null` clears it; the option resolver is the
     * fallback until the first set). */
    readonly $setToken: (token: string | null) => void
  }

  export interface Context {
    readonly options: Options
    manifest: ManifestDef.Manifest | null
    lastRequestId: string | null
  }
}
