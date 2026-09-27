import { LogLevel } from 'std:logger'

import type { ServerDef } from '../types/server'

/** Semconv's known HTTP methods — anything else is `_OTHER` (span name `HTTP`). */
export const HTTP_METHODS = new Set([
  'CONNECT',
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
  'QUERY',
  'TRACE',
])

/** The W3C `sampled` trace flag. */
export const SAMPLED = 0x01

/** A request id worth keeping: 1–128 printable ASCII, no surrounding blanks. */
export const REQUEST_ID = /^[!-~](?:[ -~]{0,126}[!-~])?$/u

/** Resources are built once per (kernel, service name); past this many names they are not
 * cached (a runaway `service` option must not grow memory). */
export const RESOURCE_CACHE_LIMIT = 256

/** `ctx.log` level → the std Logger level its severity comes from. */
export const LOG_LEVELS: Readonly<Record<keyof ServerDef.Log, LogLevel>> = {
  debug: LogLevel.debug,
  info: LogLevel.info,
  warn: LogLevel.warn,
  error: LogLevel.error,
}

/** The binding `ctx.log` forwards to the std Logger with: the record was already emitted as
 * telemetry, so the Logger's `TraceTransport` skips it (exactly one record either way). */
export const SENT_BINDING: Readonly<Record<string, string>> = { 'ozaco.telemetry': 'sent' }

/** A log line's data keys whose failure IS the line's failure (lifted out of the attributes). */
export const FAILURE_KEYS: ReadonlySet<string> = new Set(['err', 'error'])

/** `Server.actions.report` records carry this event name. */
export const DOMAIN_EVENT = 'ozaco.domain'

/** The span event an ambient recording span gets per `Server.actions.events()` item. */
export const EVENT_RECV = 'ozaco.event.recv'

/** How many `creation` links one span takes for the event items it received (a long-lived
 * listener stops linking past it — the `ozaco.event.recv` events go on; std:trace keeps 128 links
 * a span, the other reasons keep room). */
export const RECV_LINKS = 32

/** How many failures that escaped a kernel span (or were logged) are remembered, weakly — what an
 * exception record forwarded to the Logger is matched back to. */
export const NOTED_FAILURES = 64

/** The consumer span's attribute naming a `handle` subscription (semconv messaging). */
export const SUBSCRIPTION_KEY = 'messaging.destination.subscription.name'

export const DEFAULT_PAUSE_MS = 50

export const DEFAULT_DRAIN_MS = 5000

/** The most log records one node holds while it comes up (`TracerContext.boot`). */
export const BOOT_RECORDS = 256
