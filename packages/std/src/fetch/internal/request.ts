// oxlint-disable unicorn/no-array-for-each
import type { Context, Operation } from 'std:effect'
import { attempt, ensure, until, useAbortSignal } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, isFailure } from 'std:result'
import { traceNow } from 'std:trace'

import { FetchErrors } from '../errors'
import type { FetchDef } from '../types/fetch'
import { fetchImpl } from '../utils/context'

import { buildResponse } from './response'
import {
  carrierOf,
  markResponse,
  openClientSpan,
  releasing,
  sentMethod,
  withCarrier,
} from './trace'

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
 * The failure a rejected platform fetch becomes, through the `FetchErrors` matchers: a transport
 * fault ⇒ `FetchErrors.Network` (the platform's own text the message), a deadline hit ⇒
 * `FetchErrors.Timeout` naming the request and its deadline (the platform's fold under it),
 * anything else `std:result.unknown`.
 */
const failureOf = (
  error: unknown,
  target: RequestInfo | URL,
  timeoutMs: number | undefined,
): Result.Failure<unknown> => {
  const failure = asFailure(error, FetchErrors)

  return failure.error === FetchErrors.Timeout && timeoutMs !== undefined
    ? fail(FetchErrors.Timeout, `${target}: timed out after ${timeoutMs}ms`, asFailure(error))
    : failure
}

/** The platform fetch itself, bound to the calling scope (and the deadline, if any). */
function* send(
  target: RequestInfo | URL,
  init: RequestInit,
  { timeoutMs, tls }: { timeoutMs: number | undefined; tls: FetchDef.Tls | undefined },
): Operation<Response> {
  try {
    const impl = yield* fetchImpl.get()
    const scopeSignal = yield* useAbortSignal()
    const signal =
      timeoutMs === undefined
        ? scopeSignal
        : AbortSignal.any([scopeSignal, AbortSignal.timeout(timeoutMs)])

    const requestInit: RequestInit = { ...init, signal }
    if (tls !== undefined) {
      // Bun's `tls` fetch extension — not in the lib `RequestInit`; other runtimes ignore it
      ;(requestInit as RequestInit & { tls?: FetchDef.Tls }).tls = tls
    }

    return yield* until(impl!(target, requestInit))
  } catch (error) {
    return yield* failureOf(error, target, timeoutMs)
  }
}

/**
 * The raw `request` action the plugin installs: resolves the install-time defaults (base URL,
 * headers, timeout) against the per-request init, performs the fetch through `fetchImpl`, and
 * wraps the platform response. Runs INSIDE the protocol dispatch, so hooks wrap it.
 *
 * Traced: the request is an HTTP CLIENT span, its context injected into the request headers; it
 * ends with the response body (see `buildResponse`), at once when there is none, with the
 * failure when the fetch fails, cancelled when the request is halted. A body never read ends it
 * when the calling scope closes, at the time the headers arrived.
 */
export const createRequestAction = (context: Context<FetchDef.Context>) =>
  function* request(input: RequestInfo | URL, init?: FetchDef.Init): Operation<FetchDef.Response> {
    const options = yield* context.expect()
    const {
      timeoutMs: initTimeoutMs,
      headers: initHeaders,
      codec: initCodec,
      tls: initTls,
      template,
      resendCount,
      propagate: initPropagate,
      ...rest
    } = init ?? {}

    const timeoutMs = initTimeoutMs ?? options.timeoutMs
    const codec = initCodec ?? options.codec
    const tls = initTls ?? options.tls
    const target = resolveInput(input, options.baseUrl)
    const method = rest.method ?? (input instanceof Request ? input.method : 'GET')

    const live = yield* openClientSpan(target, method, { template, resendCount })
    const carrier = (initPropagate ?? options.propagate ?? true) ? yield* carrierOf(live) : {}
    const headers = withCarrier(carrier, input, mergeHeaders(options.headers, input, initHeaders))

    const requestInit: RequestInit = { ...rest }
    if (headers !== undefined) {
      requestInit.headers = headers
    }

    if (!live) {
      return buildResponse(yield* send(target, requestInit, { timeoutMs, tls }), codec, null)
    }

    // the fallback end, when the calling scope closes first: mid-request ⇒ cancelled; a body never
    // read ⇒ the request ended when its headers arrived. It lives as long as that scope, so it
    // holds the span only until the span ends (a long-lived scope must not keep every request's)
    const { span, fallback, end } = releasing(live)
    yield* ensure(end)

    const outcome = yield* attempt(() => send(target, requestInit, { timeoutMs, tls }))
    if (isFailure(outcome)) {
      yield* span.end({ failure: outcome })
      return yield* outcome
    }

    const response = outcome.value
    fallback.at = yield* span.run(() => traceNow())
    markResponse(span, response.status)

    if (response.body === null || sentMethod(method) === 'HEAD') {
      yield* span.end()
    }

    return buildResponse(response, codec, span)
  }
