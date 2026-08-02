import type { Future, Operation } from 'std:effect'

/** One namespace's entry in codegen's `apiMeta` (`ozaco pull`). */
export interface NamespaceMeta {
  /** Realtime transport of the namespace's `_realtime` channel. */
  readonly realtime?: 'websocket' | 'sse'
  /** `fn -> [METHOD, path]` — the fn's real REST route. Path params use the OpenAPI `{name}` form
   * and are filled from the call args; `SSE` marks a dedicated `stream()` route the client
   * subscribes to directly. A fn absent here falls back to `POST /<ns>/<fn>`. */
  readonly fns?: Readonly<Record<string, readonly [string, string]>>
}

export interface ClientOptions {
  /** Base URL of the wizard backend, e.g. `http://localhost:3000`. */
  readonly url: string
  /** Override for the realtime endpoint (defaults to `ws(s)://<url>/_realtime`). */
  readonly realtimeUrl?: string
  /** Bearer token — a value or a getter (e.g. a session read), resolved per call. Sent as an
   * `Authorization` header on calls, and as `?token=` on realtime channels: a browser cannot set
   * WS/SSE handshake headers, and the server promotes the query param for exactly those routes. */
  readonly token?: string | (() => string | undefined)
  /** Per-namespace routes + realtime transport, from codegen's `apiMeta` (`ozaco pull`). When
   * present the client dispatches each fn to its declared route and opens realtime channels over
   * the declared transport; namespaces absent here fall back to `POST /<ns>/<fn>` and a one-time
   * WS-then-SSE probe. */
  readonly meta?: Readonly<Record<string, NamespaceMeta>>
}

/** A query function reference: call it for a one-shot `TResult`, or `.watch(...)` for a live stream.
 * The live stream emits `TEmits`, which may differ from the one-shot `TResult` (e.g. a paginated
 * `list` returns a page one-shot but emits per-row change events on `.watch(...)`). */
export interface QueryRef<TArgs, TResult, TEmits = TResult> {
  (args: TArgs): Future<TResult>
  /** Live subscription. Resolves to an operation-native stopper — `yield* stop()` closes the socket.
   * The channel re-opens itself on a dropped connection (bounded backoff, `onError` once the budget
   * is spent) and is owned by the client, not by the calling scope, so an `await`ed subscription
   * keeps streaming: the stopper is what ends it. */
  watch(
    args: TArgs,
    onNext: (event: TEmits) => void,
    onError?: (error: unknown) => void,
  ): Future<() => Operation<void>>
}

/** A mutation function reference: call it to run the write. */
export type MutationRef<TArgs, TResult> = (args: TArgs) => Future<TResult>

/** A background action reference has the same one-shot client shape as a mutation. */
export type ActionRef<TArgs, TResult> = (args: TArgs) => Future<TResult>

/** A producer-driven stream reference: `.subscribe(...)` for a live feed of `TEmits` (metrics,
 * vitals, a log tail, …). No one-shot call. */
export interface StreamRef<TArgs, TEmits> {
  /** Same lifetime rules as {@link QueryRef.watch}: self-reopening, client-owned, stopper-ended.
   * A dedicated stream route's payload arrives exactly as the server produced it (only `_realtime`
   * frames are unwrapped), so a payload with a `result` field of its own survives intact. */
  subscribe(
    args: TArgs,
    onNext: (event: TEmits) => void,
    onError?: (error: unknown) => void,
  ): Future<() => Operation<void>>
}

/** One function's client shape, derived from its generated `{ kind, args, result, emits }`. */
export type FnRef<TFn> = TFn extends {
  kind: 'query'
  args: infer TArgs
  result: infer TResult
  emits: infer TEmits
}
  ? QueryRef<TArgs, TResult, TEmits>
  : TFn extends { kind: 'query'; args: infer TArgs; result: infer TResult }
    ? QueryRef<TArgs, TResult>
    : TFn extends { kind: 'mutation'; args: infer TArgs; result: infer TResult }
      ? MutationRef<TArgs, TResult>
      : TFn extends { kind: 'action'; args: infer TArgs; result: infer TResult }
        ? ActionRef<TArgs, TResult>
        : TFn extends { kind: 'stream'; args: infer TArgs; emits: infer TEmits }
          ? StreamRef<TArgs, TEmits>
          : never

export type ApiShape = Record<
  string,
  Record<string, { kind: string; args: unknown; result: unknown; emits?: unknown }>
>

/** The whole client: one namespace of function refs per registered namespace, typed from `<Api>`. */
export type Client<TApi extends ApiShape> = {
  readonly [NS in keyof TApi]: {
    readonly [FN in keyof TApi[NS]]: FnRef<TApi[NS][FN]>
  }
}
