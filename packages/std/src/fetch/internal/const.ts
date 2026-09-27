import type { TraceDef } from 'std:trace'

import pkg from '../../../package.json'

/** The instrumentation scope of the HTTP CLIENT spans fetch opens. */
export const TRACE_SCOPE: TraceDef.InstrumentationScope = Object.freeze({
  name: '@ozaco/std/fetch',
  version: pkg.version,
})

/** The exception log record's event name for a failure that originates in a fetch span. */
export const EXCEPTION_EVENT = 'http.client.request.exception'

/** What a redacted credential / query value reads (OTel `url.full` / `url.query` convention). */
export const REDACTED = 'REDACTED'

/** `scheme://user:pass@` — the authority's LAST `@` ends the userinfo (WHATWG). */
export const USERINFO = /^([a-z][\d+.a-z-]*:\/\/)[^#/?]*@/iu

/**
 * Query parameters whose VALUES never reach telemetry (compared lowercased): the OTel semconv
 * list (presigned S3 / GCS / Azure signatures) plus the usual key-in-query secrets.
 */
export const SENSITIVE_QUERY_KEYS: ReadonlySet<string> = new Set(
  [
    'X-Amz-Signature',
    'X-Amz-Credential',
    'X-Amz-Security-Token',
    'AWSAccessKeyId',
    'Signature',
    'sig',
    'X-Goog-Signature',
    'key',
    'api_key',
    'apikey',
    'token',
    'access_token',
    'password',
    'secret',
  ].map(key => key.toLowerCase()),
)

/** The methods the Fetch standard sends uppercased whatever the caller's casing. */
export const NORMALIZED_METHODS: ReadonlySet<string> = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'POST',
  'PUT',
])

/** The methods `http.request.method` names; any other is `_OTHER` (+ `_original`). */
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
