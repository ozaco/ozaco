import type { Operation } from 'std:effect'
import type { TraceDef } from 'std:trace'
import { inject, isTracing, startSpan } from 'std:trace'

import type { FetchDef } from '../types/fetch'
import type { Helpers } from '../types/helpers'
import { redactUrl } from '../utils/redact'

import {
  DEFAULT_PORTS,
  EXCEPTION_EVENT,
  KNOWN_METHODS,
  NORMALIZED_METHODS,
  TRACE_SCOPE,
} from './const'

// built apart from the span wrapper so its closure captures the holder alone, never the span
const fallbackEnd = (fallback: Helpers.Fallback) => (): Operation<void> | undefined =>
  fallback.span?.end(fallback.at === undefined ? { cancelled: true } : { time: fallback.at })

/** The page a relative URL resolves against in a browser (none on a server runtime). */
const documentBase = (): string | undefined =>
  (globalThis as { location?: { href?: unknown } }).location?.href as string | undefined

/** The request's URL, parsed — `undefined` for a relative string with nothing to resolve it. */
const urlOf = (target: RequestInfo | URL): URL | undefined => {
  if (target instanceof URL) {
    return target
  }

  try {
    return new URL(typeof target === 'string' ? target : target.url, documentBase())
  } catch {
    return undefined
  }
}

/** `server.address` / `server.port` (the scheme's port when implicit; IPv6 without brackets). */
const serverOf = (url: URL | undefined): TraceDef.AttributesInput => {
  if (!url?.hostname) {
    return {}
  }

  const { hostname } = url
  const address = hostname.startsWith('[') ? hostname.slice(1, -1) : hostname

  return {
    'server.address': address,
    'server.port': url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol],
  }
}

/**
 * The CLIENT span's name and its creation-time attributes (the sampling-relevant ones): named
 * `{METHOD}` / `{METHOD} {template}` — `HTTP` for a method outside the known set, which is then
 * `_OTHER` with `http.request.method_original`.
 */
const describe = (
  target: RequestInfo | URL,
  method: string,
  { template, resendCount }: Pick<FetchDef.Init, 'template' | 'resendCount'>,
): { name: string; attributes: TraceDef.AttributesInput } => {
  const sent = sentMethod(method)
  const known = KNOWN_METHODS.has(sent)
  const url = urlOf(target)
  // only a relative string with nothing to resolve it against stays unparsed
  const href = url?.href ?? String(target)
  const route = template ? ` ${template}` : ''

  return {
    name: `${known ? sent : 'HTTP'}${route}`,
    attributes: {
      'http.request.method': known ? sent : '_OTHER',
      'http.request.method_original': known ? undefined : sent,
      'url.full': redactUrl(href),
      'url.template': template || undefined,
      ...serverOf(url),
      'http.request.resend_count':
        typeof resendCount === 'number' && resendCount > 0 ? Math.floor(resendCount) : undefined,
    },
  }
}

/** The method on the wire: the Fetch standard uppercases the six it normalizes, no other. */
export const sentMethod = (method: string): string => {
  const upper = method.toUpperCase()

  return NORMALIZED_METHODS.has(upper) ? upper : method
}

/**
 * The request's HTTP CLIENT span, or `null` while tracing is off (or suppressed) where the
 * request runs. A failure originating in it records as `http.client.request.exception`.
 */
export function* openClientSpan(
  target: RequestInfo | URL,
  method: string,
  naming: Pick<FetchDef.Init, 'template' | 'resendCount'>,
): Operation<TraceDef.LiveSpan | null> {
  if (!(yield* isTracing())) {
    return null
  }

  const { name, attributes } = describe(target, method, naming)

  return yield* startSpan(name, {
    kind: 'client',
    scope: TRACE_SCOPE,
    attributes,
    failure: { eventName: EXCEPTION_EVENT },
  })
}

/**
 * The trace-context headers the request carries: the CLIENT span's (marked `ozaco=1` while it
 * records), else the ambient context as it is — a pass-through inbound one while tracing is off,
 * unsampled under suppression — else none.
 */
export function* carrierOf(span: TraceDef.LiveSpan | null): Operation<TraceDef.Carrier> {
  if (span) {
    return yield* span.run(() => inject({ ozaco: true }))
  }

  return yield* inject()
}

/**
 * `headers` (what the platform would send: the merged headers, else a `Request` input's own)
 * with the carrier set — untouched when there is nothing to inject or the caller already set a
 * `traceparent` (the caller's context wins; its `tracestate` is kept with it).
 */
export const withCarrier = (
  carrier: TraceDef.Carrier,
  input: RequestInfo | URL,
  headers: HeadersInit | undefined,
): HeadersInit | undefined => {
  if (!carrier.traceparent) {
    return headers
  }

  const sent = new Headers(headers ?? (input instanceof Request ? input.headers : undefined))
  if (sent.has('traceparent')) {
    return headers
  }

  sent.set('traceparent', carrier.traceparent)

  // a `tracestate` belongs to its `traceparent`: a stray caller one never pairs with ours
  if (carrier.tracestate) {
    sent.set('tracestate', carrier.tracestate)
  } else {
    sent.delete('tracestate')
  }

  return sent
}

/**
 * The request span as the request hands it on (`span`: ending it lets go of it) and the
 * scope-close fallback `end` (cancelled while no response `arrived`, else ended at that time).
 * The fallback lives as long as the calling scope, so it drops the span the moment the span ends:
 * a long-lived scope keeps a spent holder per request, never every request's span.
 */
export const releasing = (live: TraceDef.LiveSpan): Helpers.Released => {
  const fallback: Helpers.Fallback = { span: live, at: undefined }

  const span: TraceDef.LiveSpan = {
    ...live,
    *end(options) {
      fallback.span = undefined
      yield* live.end(options)
    },
  }

  return { span, fallback, end: fallbackEnd(fallback) }
}

/**
 * The response arrived: `http.response.status_code`, and for 4xx / 5xx the CLIENT span fails
 * (`error.type` = the status code; no status message — the code says it).
 */
export const markResponse = (span: TraceDef.LiveSpan, status: number): void => {
  if (status <= 0) {
    return
  }

  span.setAttribute('http.response.status_code', status)

  if (status >= 400) {
    span.setAttribute('error.type', String(status))
    span.setStatus({ code: 'error' })
  }
}
