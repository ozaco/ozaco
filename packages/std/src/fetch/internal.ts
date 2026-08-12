import type { Context, Operation } from 'std:effect'
import { until, useAbortSignal } from 'std:effect'
import { asFailure, fail } from 'std:result'

import { fetchImpl } from './context'
import type { FetchDef } from './types'
import { createFetchResponse } from './utils'

/** Resolve a RELATIVE string input against the configured base URL (standard
 * `new URL(input, baseUrl)` semantics — absolute strings ignore the base); `URL` instances and
 * `Request` objects pass through untouched. */
const resolveInput = (input: RequestInfo | URL, baseUrl: string | URL | undefined) => {
  if (baseUrl === undefined || typeof input !== 'string') {
    return input
  }

  return new URL(input, baseUrl)
}

/** Merge the installed default headers UNDER the per-request ones: a `Request` input's own headers,
 * then `init.headers`, override the defaults name by name. Without defaults the per-request value
 * passes through untouched (so a bare `Request`'s headers stay in charge). */
const mergeHeaders = (
  defaults: HeadersInit | undefined,
  input: RequestInfo | URL,
  headers: HeadersInit | undefined,
) => {
  if (defaults === undefined) {
    return headers
  }

  const merged = new Headers(defaults)

  if (input instanceof Request) {
    for (const [name, value] of input.headers) {
      merged.set(name, value)
    }
  }

  if (headers !== undefined) {
    for (const [name, value] of new Headers(headers)) {
      merged.set(name, value)
    }
  }

  return merged
}

/** The raw `request` action the plugin installs: resolves the install-time defaults (base URL,
 * headers, timeout) against the per-request init, performs the fetch through `fetchImpl`, and
 * wraps the platform response. Runs INSIDE the protocol dispatch, so hooks wrap it. */
export const createRequestAction = (context: Context<FetchDef.Context>) =>
  function* request(input: RequestInfo | URL, init?: FetchDef.Init): Operation<FetchDef.Response> {
    const options = yield* context.expect()
    const { timeoutMs: initTimeoutMs, headers: initHeaders, codec: initCodec, ...rest } = init ?? {}
    const timeoutMs = initTimeoutMs ?? options.timeoutMs
    const codec = initCodec ?? options.codec
    const target = resolveInput(input, options.baseUrl)
    const headers = mergeHeaders(options.headers, input, initHeaders)

    try {
      const impl = yield* fetchImpl.get()
      const scopeSignal = yield* useAbortSignal()
      const signal =
        timeoutMs === undefined
          ? scopeSignal
          : AbortSignal.any([scopeSignal, AbortSignal.timeout(timeoutMs)])
      const requestInit: RequestInit = { ...rest, signal }

      if (headers !== undefined) {
        requestInit.headers = headers
      }

      const response = yield* until(impl!(target, requestInit))

      return createFetchResponse(response, codec)
    } catch (error) {
      // `until` reifies a rejection into a Failure, so unwrap one level; matched by NAME, not
      // `instanceof DOMException` — runtimes disagree on the constructor
      const raw = (error as { error?: unknown } | null)?.error ?? error

      if (timeoutMs !== undefined && (raw as { name?: string } | null)?.name === 'TimeoutError') {
        return yield* fail('timeout', `${target}: timed out after ${timeoutMs}ms`)
      }

      return yield* asFailure(error)
    }
  }
