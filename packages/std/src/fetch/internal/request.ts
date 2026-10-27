// oxlint-disable unicorn/no-array-for-each
import type { Context, Operation } from 'std:effect'
import { attempt, backoffDelay, ensure, sleep, until, useAbortSignal } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, isFailure } from 'std:result'
import { Trace } from 'std:trace'

import { FetchErrors } from '../errors'
import type { FetchDef } from '../types/fetch'
import type { Helpers } from '../types/helpers'
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
  { timeoutMs, tls, proxy }: Helpers.SendSettings,
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

    if (proxy !== undefined) {
      // Bun's `proxy` fetch extension, likewise
      ;(requestInit as RequestInit & { proxy?: string }).proxy = proxy
    }

    return yield* until(impl!(target, requestInit))
  } catch (error) {
    return yield* failureOf(error, target, timeoutMs)
  }
}

/** Whether the policy re-sends after this outcome — the failure's tag, else the status. */
const retryable = (policy: FetchDef.RetryPolicy, outcome: Result<Response>): boolean => {
  const on = policy.on ?? ['network', '5xx']

  if (isFailure(outcome)) {
    return (
      (outcome.error === FetchErrors.Network && on.includes('network')) ||
      (outcome.error === FetchErrors.Timeout && on.includes('timeout'))
    )
  }

  const { status } = outcome.value

  return (status >= 500 && on.includes('5xx')) || (status === 429 && on.includes('429'))
}

/** `send`, re-sent as the policy says: a response that is not kept is discarded (its body
 * cancelled), `onResend(n)` notes the n-th re-send on the span, the backoff waits in between. */
function* sendWithRetry(
  target: RequestInfo | URL,
  init: RequestInit,
  settings: Helpers.SendSettings & {
    readonly retry: FetchDef.RetryPolicy | undefined
    readonly onResend: (count: number) => void
  },
): Operation<Response> {
  const { retry } = settings
  const attempts = Math.max(1, Math.floor(retry?.attempts ?? 3))

  for (let attemptNumber = 1; ; attemptNumber += 1) {
    const outcome = yield* attempt(() => send(target, init, settings))

    if (!retry || attemptNumber >= attempts || !retryable(retry, outcome)) {
      return isFailure(outcome) ? yield* outcome : outcome.value
    }

    if (!isFailure(outcome)) {
      yield* attempt(() => until(outcome.value.body?.cancel() ?? Promise.resolve()))
    }

    settings.onResend(attemptNumber)
    yield* sleep(backoffDelay(attemptNumber, retry))
  }
}

/** The response with its body counted: past `maxBytes` the read fails `std:fetch.too-large`. */
const capped = (response: Response, maxBytes: number, target: RequestInfo | URL): Response => {
  if (response.body === null) {
    return response
  }

  let seen = 0
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength

        if (seen > maxBytes) {
          controller.error(
            fail(FetchErrors.TooLarge, `${target}: response body exceeds ${maxBytes} bytes`),
          )

          return
        }

        controller.enqueue(chunk)
      },
    }),
  )

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
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
      retry: initRetry,
      maxBytes: initMaxBytes,
      proxy: initProxy,
      ...rest
    } = init ?? {}

    const timeoutMs = initTimeoutMs ?? options.timeoutMs
    const codec = initCodec ?? options.codec
    const tls = initTls ?? options.tls
    const retry = initRetry ?? options.retry
    const maxBytes = initMaxBytes ?? options.maxBytes
    const proxy = initProxy ?? options.proxy
    const target = resolveInput(input, options.baseUrl)
    const method = rest.method ?? (input instanceof Request ? input.method : 'GET')

    const live = yield* openClientSpan(target, method, {
      template,
      resendCount,
      sensitiveKeys: options.sensitiveKeys,
    })
    const carrier = (initPropagate ?? options.propagate ?? true) ? yield* carrierOf(live) : {}
    const headers = withCarrier(carrier, input, mergeHeaders(options.headers, input, initHeaders))

    const requestInit: RequestInit = { ...rest }

    if (headers !== undefined) {
      requestInit.headers = headers
    }

    const sendSettings = { timeoutMs, tls, proxy, retry }
    const sized = (response: Response) =>
      maxBytes === undefined ? response : capped(response, maxBytes, target)

    if (!live) {
      const plain = yield* sendWithRetry(target, requestInit, { ...sendSettings, onResend() {} })

      return buildResponse(sized(plain), codec, null)
    }

    // the fallback end, when the calling scope closes first: mid-request ⇒ cancelled; a body never
    // read ⇒ the request ended when its headers arrived. It lives as long as that scope, so it
    // holds the span only until the span ends (a long-lived scope must not keep every request's)
    const { span, fallback, end } = releasing(live)

    yield* ensure(end)

    const outcome = yield* attempt(() =>
      sendWithRetry(target, requestInit, {
        ...sendSettings,
        onResend: count => span.setAttribute('http.request.resend_count', count),
      }),
    )

    if (isFailure(outcome)) {
      yield* span.end({ failure: outcome })

      return yield* outcome
    }

    const response = sized(outcome.value)

    fallback.at = yield* span.run(() => Trace.actions.traceNow())
    markResponse(span, response.status)

    if (response.body === null || sentMethod(method) === 'HEAD') {
      yield* span.end()
    }

    return buildResponse(response, codec, span)
  }
