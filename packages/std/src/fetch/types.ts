import type { Future, Stream } from 'std:effect'
import type { Result } from 'std:result'

export namespace FetchDef {
  /** Thrown errors (network faults, aborts, body-read failures) pass through UNTOUCHED — reified with
   * `asFailure` so their original name + cause chain survive — hence `unknown`. The only string tags
   * fetch raises itself are the deliberate, non-thrown conditions: `'http-status'` (a non-ok response
   * under `.expect()`), `'parse'` (a response with no body) and `'timeout'` (a `timeoutMs` deadline
   * hit before the response settled). */
  export type Error = unknown

  /** The body union `fetch()` accepts (platform `BodyInit`), spelled out so callers compiling
   * without the `dom` lib don't have to hand-roll it. */
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
     * deadline — the failure surfaces as the `'timeout'` tag. Scope halt/failure still aborts. */
    timeoutMs?: number
  }

  /** The underlying fetch implementation `fetch()` dispatches through (injectable via `fetchImpl`). */
  export type Impl = (input: RequestInfo | URL, init?: RequestInit) => Promise<globalThis.Response>

  /** The close value a codec stream settles with: `true` on a clean end, or a failure mid-stream. */
  type StreamClose = true | Result.Failure<unknown>

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
    json<T = unknown>(): Future<T>
    text(): Future<string>
    arrayBuffer(): Future<ArrayBuffer>
    blob(): Future<Blob>
    formData(): Future<FormData>
    bytes(): Future<Uint8Array>
    /** Whole body, decoded once through the registered codec (auto-installs `JsonCodec` if absent). */
    body<T = unknown>(): Future<T>
    /** Body piped through the codec's streaming decoder — one decoded value per chunk. */
    stream<T = unknown>(): Future<Stream<T, StreamClose>>
    /** The raw, undecoded byte stream of the response body. */
    raw(): Future<Stream<Uint8Array, void>>
    expect(): Future<Response>
  }

  export interface Operation extends Future<Response> {
    json<T = unknown>(): Future<T>
    text(): Future<string>
    arrayBuffer(): Future<ArrayBuffer>
    blob(): Future<Blob>
    formData(): Future<FormData>
    bytes(): Future<Uint8Array>
    body<T = unknown>(): Future<T>
    stream<T = unknown>(): Future<Stream<T, StreamClose>>
    raw(): Future<Stream<Uint8Array, void>>
    expect(): Operation
  }
}
