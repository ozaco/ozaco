/** Protocol subtype markers. */
export const SERVER = Symbol.for('server:server')
export const SERVER_EDGE = Symbol.for('server:edge')
export const SERVER_CARRIER = Symbol.for('server:carrier')
export const SERVER_OUTCOMES = Symbol.for('server:outcomes')
export const SERVER_OBSERVE = Symbol.for('server:observe')
export const SERVER_OBSERVE_EXPORTER = Symbol.for('server:observe-exporter')

/** Brands on definition-time values. */
export const SERVICE = Symbol.for('server:service')
export const ACTION = Symbol.for('server:action')
export const STREAM_DECL = Symbol.for('server:stream-decl')
export const PARTS_DECL = Symbol.for('server:parts-decl')

/** The brand a runtime stream carries (`Branded<B>`). */
export const STREAM_BRAND = Symbol.for('server:stream-brand')

/** Wire header names (carried by the transport; mirrored as HTTP headers at the edge). */
export enum HEADERS {
  cid = 'oz-cid',
  requestId = 'x-request-id',

  /** W3C trace context in (every edge request, every client call) and back out (W3C draft
   * `traceresponse`: the edge span's context, `00-<trace>-<span>-<flags>`). */
  traceparent = 'traceparent',
  tracestate = 'tracestate',
  traceresponse = 'traceresponse',

  /** server → client: the brand of a streamed body. */
  brand = 'oz-brand',

  /** server → client: the failure tag of an error response. */
  error = 'oz-error',
}

/** Default deadlines. */
export const DEFAULT_TIMEOUT_MS = 30_000
export const DEFAULT_OUTCOME_TTL_MS = 10 * 60 * 1000

/** Observe tables live under this prefix (`__` is the db's own, so one underscore). */
export const OBSERVE_PREFIX = '_ob_'

/** where the observe dev console mounts (the docs manifest links it when it is there). */
export const OBSERVE_CONSOLE_PATH = '/_observe'

/** The service id format: `name@version#instance`. */
export const serviceIdOf = (name: string, version: string, instance: string): string =>
  `${name}@${version}#${instance}`

/** The instrumentation scope name of every kernel span / record; a plugin's is
 * `@ozaco/server/<plugin>` (`scopeOf(plugin)`). */
export const TRACE_SCOPE = '@ozaco/server'

/**
 * The exception log record's `eventName` by where a failure ORIGINATES (design §6.2) — the span
 * option `failure.eventName` of each server span kind.
 */
export const EXCEPTION_EVENT_NAME = {
  /** the HTTP / WS edge span (edge-originated failures: unrouted, decode, paused, guard, …). */
  edge: 'http.server.request.exception',

  /** an in-process dispatch span (`internal`). */
  action: 'ozaco.action.exception',

  /** a dispatch received over a carrier (`server`). */
  rpcServer: 'rpc.server.call.exception',

  /** the caller-side carrier span (`client`). */
  rpcClient: 'rpc.client.call.exception',

  /** `emit` (`producer`). */
  send: 'messaging.send.exception',

  /** an event handler (`consumer`). */
  process: 'messaging.process.exception',
} as const

/** How long an accepted socket may wait for its first `{ t: 'auth' }` frame before the
 * missing authorization closes it (browsers cannot set WS headers — tokens arrive in-band). */
export const SOCKET_AUTH_GRACE_MS = 2000

/** The per-record log attribute budget the kernel applies ONCE, before any sink sees a record
 * (every sink holds the same data): what every log backend ingests — Loki refuses a line with
 * more than 128 structured-metadata entries (its own ~15 and the resource's included) or 64 KiB
 * of them. */
export const LOG_MAX_ATTRIBUTES = 96
export const LOG_MAX_ATTRIBUTE_BYTES = 48 * 1024
