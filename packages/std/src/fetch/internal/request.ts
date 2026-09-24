// oxlint-disable unicorn/no-array-for-each
import type { Context, Operation } from 'std:effect'
import { until, useAbortSignal } from 'std:effect'
import { asFailure, fail } from 'std:result'

import { FetchErrors } from '../errors'
import type { FetchDef } from '../types'
import { fetchImpl } from '../utils/context'
import { createFetchResponse } from '../utils/response'

/**
 * Resolve a RELATIVE string input against the configured base URL (standard
 * `new URL(input, baseUrl)` semantics — absolute strings ignore the base); `URL` instances and
 * `Request` objects pass through untouched.
 */
const resolveInput = (input: RequestInfo | URL, baseUrl: string | URL | undefined) => {
  if (baseUrl === undefined || typeof input !== 'string') {
    return input
  }

  return new URL(input, baseUrl)
}

/**
 * Merge the installed default headers UNDER the per-request ones: a `Request` input's own headers,
 * then `init.headers`, override the defaults name by name. Without defaults the per-request value
 * passes through untouched (so a bare `Request`'s headers stay in charge).
 */
const mergeHeaders = (
  defaults: HeadersInit | undefined,
  input: RequestInfo | URL,
  headers: HeadersInit | undefined,
) => {
  if (defaults === undefined) {
    return headers
  }

  const merged = new Headers(defaults)

  // `forEach`, not `for…of`: `Headers` is only iterable under the `DOM.Iterable` lib (ts2488)
  const override = (value: string, name: string) => merged.set(name, value)

  if (input instanceof Request) {
    input.headers.forEach(override)
  }

  if (headers !== undefined) {
    new Headers(headers).forEach(override)
  }

  return merged
}

/**
 * A platform transport fault — the connection never produced a response (refused, reset, DNS,
 * TLS). Fetch rejects those with a `TypeError` (spec) and Bun adds a string `code`
 * (`ConnectionRefused`, `ECONNRESET`, …); aborts and timeouts are NOT network faults.
 */
const isNetworkError = (
  raw: unknown,
): raw is { name?: string; code?: unknown; message?: string } => {
  if (raw === null || typeof raw !== 'object') {
    return false
  }

  const { name, code } = raw as { name?: unknown; code?: unknown }
  if (name === 'AbortError' || name === 'TimeoutError') {
    return false
  }

  return raw instanceof TypeError || (raw instanceof Error && typeof code === 'string')
}

// the platform code when there is one (Bun's refused connection has an EMPTY message), else the
// platform message, else the error name
const networkMessage = (raw: { name?: string; code?: unknown; message?: string }): string => {
  if (typeof raw.code === 'string' && raw.code !== '') {
    return raw.code
  }

  return raw.message || raw.name || 'network error'
}

/**
 * The raw `request` action the plugin installs: resolves the install-time defaults (base URL,
 * headers, timeout) against the per-request init, performs the fetch through `fetchImpl`, and
 * wraps the platform response. Runs INSIDE the protocol dispatch, so hooks wrap it.
 */
export const createRequestAction = (context: Context<FetchDef.Context>) =>
  function* request(input: RequestInfo | URL, init?: FetchDef.Init): Operation<FetchDef.Response> {
    const options = yield* context.expect()
    const {
      timeoutMs: initTimeoutMs,
      headers: initHeaders,
      codec: initCodec,
      tls: initTls,
      ...rest
    } = init ?? {}

    const timeoutMs = initTimeoutMs ?? options.timeoutMs
    const codec = initCodec ?? options.codec
    const tls = initTls ?? options.tls
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
      if (tls !== undefined) {
        // Bun's `tls` fetch extension — not in the lib `RequestInit`; other runtimes ignore it
        ;(requestInit as RequestInit & { tls?: FetchDef.Tls }).tls = tls
      }

      const response = yield* until(impl!(target, requestInit))

      return createFetchResponse(response, codec)
    } catch (error) {
      // `until` reifies a rejection into a Failure, so unwrap one level; matched by NAME, not
      // `instanceof DOMException` — runtimes disagree on the constructor
      const raw = (error as { error?: unknown } | null)?.error ?? error

      if (timeoutMs !== undefined && (raw as { name?: string } | null)?.name === 'TimeoutError') {
        return yield* fail(FetchErrors.Timeout, `${target}: timed out after ${timeoutMs}ms`)
      }

      if (isNetworkError(raw)) {
        return yield* fail(FetchErrors.Network, networkMessage(raw))
      }

      return yield* asFailure(error)
    }
  }
