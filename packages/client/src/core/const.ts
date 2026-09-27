/** Wire headers the client reads/writes (mirrors the server's). */
export enum HEADERS {
  requestId = 'x-request-id',
  brand = 'oz-brand',
  error = 'oz-error',

  /** W3C trace context the client sends: its CLIENT span's (`ozaco=1` in `tracestate` while it
   * records), else the caller's ambient context as it is. */
  traceparent = 'traceparent',
  tracestate = 'tracestate',

  /** W3C draft: the server's edge span context (`00-<trace>-<span>-<flags>`) — `$lastTraceId`. */
  traceresponse = 'traceresponse',
}

export const DEFAULT_DOCS_PATH = '/docs'
export const DEFAULT_REALTIME_SUFFIX = '/_realtime'
export const DEFAULT_TIMEOUT_MS = 30_000
