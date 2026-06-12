import type { Future, Stream } from 'std:effect'
import type { Result } from 'std:result'

export namespace FetchDef {
  export type Error = 'http-status' | 'network' | 'parse' | 'abort'

  export type Init = Omit<RequestInit, 'signal'> & { signal?: never }

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
    json<T = unknown>(): Future<T, Error>
    text(): Future<string, Error>
    arrayBuffer(): Future<ArrayBuffer, Error>
    blob(): Future<Blob, Error>
    formData(): Future<FormData, Error>
    bytes(): Future<Uint8Array, Error>
    /** Whole body, decoded once through the registered codec (auto-installs `JsonCodec` if absent). */
    body<T = unknown>(): Future<T, Error>
    /** Body piped through the codec's streaming decoder — one decoded value per chunk. */
    stream<T = unknown>(): Future<Stream<T, StreamClose>, Error>
    /** The raw, undecoded byte stream of the response body. */
    raw(): Future<Stream<Uint8Array, void>, Error>
    expect(): Future<Response, Error>
  }

  export interface Operation extends Future<Response, Error> {
    json<T = unknown>(): Future<T, Error>
    text(): Future<string, Error>
    arrayBuffer(): Future<ArrayBuffer, Error>
    blob(): Future<Blob, Error>
    formData(): Future<FormData, Error>
    bytes(): Future<Uint8Array, Error>
    body<T = unknown>(): Future<T, Error>
    stream<T = unknown>(): Future<Stream<T, StreamClose>, Error>
    raw(): Future<Stream<Uint8Array, void>, Error>
    expect(): Operation
  }
}
