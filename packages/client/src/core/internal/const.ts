import type { TraceDef } from 'std:trace'

import pkg from '../../../package.json'

/** The instrumentation scope of the CLIENT spans the client opens. */
export const TRACE_SCOPE: TraceDef.InstrumentationScope = Object.freeze({
  name: '@ozaco/client',
  version: pkg.version,
})

/** The exception record's event name for a failure that originates in a client call's span. */
export const EXCEPTION_EVENT = 'http.client.request.exception'

/** The methods `http.request.method` names; any other is `_OTHER` (+ `_original`, span `HTTP`). */
export const KNOWN_METHODS: ReadonlySet<string> = new Set([
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

/** `server.port` when the URL leaves it implicit. */
export const DEFAULT_PORTS: Readonly<Record<string, number>> = Object.freeze({
  'http:': 80,
  'https:': 443,
  'ws:': 80,
  'wss:': 443,
})

/** How many hex digits of the answering span's id a decoded failure's `remote: …` cause keeps. */
export const REMOTE_SPAN_DIGITS = 8

/** The status a failure counts as when no reply said otherwise (network, timeout, decode). */
export const UNANSWERED_STATUS = 500

/**
 * The realtime frame field a RE-subscription carries after the socket reconnected, in place of
 * its own `traceparent`: the `traceparent` the watch opened with — the server links it
 * (`ozaco.link.reason = 'ws.reconnect'`) to the redial's fresh root, so a reconnect is never an
 * unrelated trace, nor a late child of the opening one.
 */
export const RECONNECT_FIELD = 'reconnect'
