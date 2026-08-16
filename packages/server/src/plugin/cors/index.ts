/**
 * `server:plugin/cors` — CORS at the gateway edge: a pure response decorator adding the
 * `access-control-*` headers for allowed origins, plus a preflight handler answering unrouted
 * `OPTIONS` requests with 204. Requires an installed (set-up) `DefaultGateway`.
 */
export * from './definition'
export type * from './types'
