/** Protocol subtype markers. */
export const SERVER = Symbol.for('server:server')
export const SERVER_EDGE = Symbol.for('server:edge')
export const SERVER_CARRIER = Symbol.for('server:carrier')
export const SERVER_OUTCOMES = Symbol.for('server:outcomes')
export const SERVER_OBSERVE = Symbol.for('server:observe')

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
  span = 'oz-span',
  parent = 'oz-parent',
  traceparent = 'traceparent',
  lane = 'oz-lane',

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

/** `gw>todos>ai` — the hops of a request tree, rendered. */
export const laneOf = (hops: readonly { readonly service: string }[]): string =>
  hops.map(hop => hop.service).join('>')
