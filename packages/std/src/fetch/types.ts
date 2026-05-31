import type { Future, Stream } from 'std:effect'

export type FetchError = 'http-status' | 'network' | 'parse' | 'abort'

export type FetchInit = Omit<RequestInit, 'signal'> & { signal?: never }

/** The underlying fetch implementation `fetch()` dispatches through (injectable via `fetchImpl`). */
export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface FetchResponse {
  readonly raw: Response
  readonly ok: boolean
  readonly status: number
  readonly statusText: string
  readonly headers: Headers
  readonly url: string
  readonly redirected: boolean
  readonly bodyUsed: boolean
  readonly type: ResponseType
  json<T = unknown>(): Future<T, FetchError>
  text(): Future<string, FetchError>
  arrayBuffer(): Future<ArrayBuffer, FetchError>
  blob(): Future<Blob, FetchError>
  formData(): Future<FormData, FetchError>
  bytes(): Future<Uint8Array, FetchError>
  body(): Future<Stream<Uint8Array, void>, FetchError>
  expect(): Future<FetchResponse, FetchError>
}

export interface FetchOperation extends Future<FetchResponse, FetchError> {
  json<T = unknown>(): Future<T, FetchError>
  text(): Future<string, FetchError>
  arrayBuffer(): Future<ArrayBuffer, FetchError>
  blob(): Future<Blob, FetchError>
  formData(): Future<FormData, FetchError>
  bytes(): Future<Uint8Array, FetchError>
  body(): Future<Stream<Uint8Array, void>, FetchError>
  expect(): FetchOperation
}
