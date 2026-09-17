import type { CodecDef } from 'std:codec'
import type { Flow, Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

export type FetchDef = Plugin<FetchDef.Context, [options?: FetchDef.Options], FetchDef.Contract>

export namespace FetchDef {
  /**
   * Thrown errors (network faults, aborts, body-read failures) pass through UNTOUCHED — reified
   * with `asFailure` so their original name + cause chain survive — hence `unknown`. The only
   * string tags fetch raises itself are the deliberate, non-thrown conditions: `FetchErrors.HttpStatus` (a
   * non-ok response under `.expect()`), `FetchErrors.Parse` (a response with no body) and `FetchErrors.Timeout` (a
   * `timeoutMs` deadline hit before the response settled).
   *
   * No signature refers to it (a failure's error is `unknown` everywhere in std); it exists as the
   * named place this contract is written down, for consumers annotating their own handlers.
   */
  export type Error = unknown

  /**
   * The body union requests accept (platform `BodyInit`), spelled out so callers compiling
   * without the `dom` lib don't have to hand-roll it. `Init` itself stays `RequestInit`-based, so
   * nothing in std refers to this type — it is there for consumers typing their own body builders.
   * It is slightly WIDER than the lib's `BodyInit` (an `ArrayBufferView` here may sit over a
   * `SharedArrayBuffer`), so narrow it where it meets `Init.body`.
   */
  export type Body =
    | string
    | Blob
    | ArrayBuffer
    | ArrayBufferView
    | FormData
    | URLSearchParams
    | ReadableStream<Uint8Array>
    | null

  export type Init = Omit<RequestInit, 'signal'> & {
    signal?: never

    /** Aborts the request (via the internal `AbortController`) if no response settled within the
     * deadline — the failure surfaces as the `FetchErrors.Timeout` tag. Overrides the installed `timeoutMs`
     * default. Scope halt/failure still aborts. */
    timeoutMs?: number

    /** Preferred codec for THIS request's `body()`/`flow()` decoding — pinned dispatch to that
     * impl instead of the routed `Codec` protocol. Overrides the install-time `codec` default.
     * Stripped before the platform fetch; the impl must be installed in scope. */
    codec?: CodecDef
  }

  /** `Init` for the method shorthands (`get`/`post`/…), which pin `method` themselves. */
  export type MethodInit = Omit<Init, 'method'>

  /** The underlying fetch implementation requests dispatch through (injectable via `fetchImpl`). */
  export type Impl = (input: RequestInfo | URL, init?: RequestInit) => Promise<globalThis.Response>

  /** The close value a codec flow settles with: `true` on a clean end, or a failure mid-flow. */
  export type FlowClose = true | Result.Failure<unknown>

  /** Install-time options; every field is optional and becomes a scope-wide default. */
  export interface Options {
    /** Base URL that RELATIVE string inputs resolve against (standard `new URL(input, baseUrl)`
     * semantics); absolute URL strings, `URL` instances, and `Request` objects pass through. */
    baseUrl?: string | URL | undefined

    /** Default headers, merged UNDER the per-request ones — a `Request` input's own headers and
     * `init.headers` both override them, name by name. */
    headers?: HeadersInit | undefined

    /** Default deadline applied to every request; a per-request `init.timeoutMs` overrides it. */
    timeoutMs?: number | undefined

    /** Plugin-wide preferred codec for `body()`/`flow()` decoding — pinned dispatch to that impl
     * instead of the routed `Codec` protocol (highest-priority install). A per-request
     * `init.codec` overrides it; the impl must be installed in scope. */
    codec?: CodecDef | undefined
  }

  /** The installed plugin context: the resolved `Options`, built once by `setup`. */
  export interface Context {
    baseUrl: string | URL | undefined
    headers: HeadersInit | undefined
    timeoutMs: number | undefined
    codec: CodecDef | undefined
  }

  export interface Response {
    /** The underlying platform `Response` (escape hatch). */
    readonly native: globalThis.Response
    readonly ok: boolean
    readonly status: number
    readonly statusText: string
    readonly headers: Headers
    readonly url: string
    readonly redirected: boolean
    readonly bodyUsed: boolean
    readonly type: ResponseType

    json<T = unknown>(): Operation<T>
    text(): Operation<string>
    arrayBuffer(): Operation<ArrayBuffer>
    blob(): Operation<Blob>
    formData(): Operation<FormData>
    bytes(): Operation<Uint8Array>

    /** Whole body, decoded once through the registered codec — a codec (e.g. `JsonCodec`) must be
     * installed in scope, otherwise the read fails with `missing-action`. An EMPTY payload (204, a
     * bodiless 200) resolves `undefined` without touching the codec: type it in when that can
     * happen (`body<Foo | undefined>()`). */
    body<T = unknown>(): Operation<T>
    /** Body piped through the codec's streaming decoder — one decoded value per chunk. */
    flow<T = unknown>(): Operation<Flow<T, FlowClose>>
    /** The raw, undecoded byte flow of the response body. */
    raw(): Operation<Flow<Uint8Array, void>>

    /** Raises `FetchErrors.HttpStatus` unless the response is `ok`; returns the response otherwise. */
    expect(): Operation<Response>
  }

  /**
   * The action contract. `request` is the single choke point every verb funnels through — the
   * method shorthands delegate to the PINNED `FetchClient.actions.request`, and hooks installed
   * against it (`Fetch.around({ request })`) still wrap the actual network call no matter which
   * verb was used.
   * Hooks see the PRE-resolution arguments (`baseUrl`/default-header/timeout merging happens
   * inside the impl). Usage is two-step: `const res = yield* Fetch.actions.get(url)`, then
   * `yield* res.json<T>()` (or `res.expect()` first).
   */
  export interface Contract {
    request(input: RequestInfo | URL, init?: Init): Operation<Response>

    get(input: RequestInfo | URL, init?: MethodInit): Operation<Response>
    post(input: RequestInfo | URL, init?: MethodInit): Operation<Response>
    put(input: RequestInfo | URL, init?: MethodInit): Operation<Response>
    patch(input: RequestInfo | URL, init?: MethodInit): Operation<Response>
    delete(input: RequestInfo | URL, init?: MethodInit): Operation<Response>
    head(input: RequestInfo | URL, init?: MethodInit): Operation<Response>
  }
}
