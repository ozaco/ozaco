import { CoreErrors } from './errors'

/** Brand for objects created by `defineAction`. */
export const ACTION = Symbol.for('server:core:action')
/** Brand for objects created by `defineService`. */
export const SERVICE = Symbol.for('server:core:service')
/** Brand for channel declarations created by the `channel` constructors. */
export const CHANNEL = Symbol.for('server:core:channel')

/** Protocol subtypes (the `_st` of each `defineProtocol` call in `definitions.ts`). */
export const BROKER = Symbol.for('server:core:broker')
export const TRANSPORT = Symbol.for('server:core:transport')
export const POLICY = Symbol.for('server:core:policy')
export const GATEWAY = Symbol.for('server:core:gateway')
export const GATEWAY_ADAPTER = Symbol.for('server:core:gateway-adapter')
export const METRICS_STORE = Symbol.for('server:core:metrics-store')
export const AUTH_STRATEGY = Symbol.for('server:core:auth-strategy')
export const TRACER = Symbol.for('server:core:tracer')
export const TRACE_EXPORTER = Symbol.for('server:core:trace-exporter')

/** The non-value data planes an action can declare and a handler can take with `useSource`. */
export enum DataType {
  normal = 'normal',
  stream = 'stream',
  multistream = 'multistream',
  socket = 'socket',
}

/**
 * Policy onion order — LOWEST priority is the OUTERMOST layer. Timeout sits innermost so its
 * failure is observable by every outer layer instead of becoming a scope halt.
 */
export const PolicyPriority = {
  cache: 0,
  fallback: 5,
  bucket: 10,
  bulk: 20,
  rateLimit: 25,
  retry: 30,
  circuitBreaker: 40,
  metrics: 50,
  timeout: 60,
} as const

/** Wire spec version stamped into every envelope. */
export const WIRE_VERSION = 1

/** Header carrying (and echoing back) the external request id at the edge. */
export const REQUEST_ID_HEADER = 'x-request-id'

/** How long a dispatch may stay unacknowledged before failing `TimeoutUnreached`. */
export const ACK_TIMEOUT_MS = 5000
/** How long an acknowledged dispatch may run before failing `TimeoutPending`. */
export const REQUEST_TIMEOUT_MS = 30_000
/** How long recorded outcomes stay queryable via `Broker.actions.outcome(cid)`. */
export const OUTCOME_TTL_MS = 600_000

/** Default HTTP status per core failure tag; action `errors` maps override per tag. */
export const CoreStatusMap: Record<string, number> = {
  [CoreErrors.Configuration]: 500,
  [CoreErrors.Validation]: 400,
  [CoreErrors.BadRequest]: 400,
  [CoreErrors.Unauthorized]: 401,
  [CoreErrors.Forbidden]: 403,
  [CoreErrors.NotFound]: 404,
  [CoreErrors.Conflict]: 409,
  [CoreErrors.PayloadTooLarge]: 413,
  [CoreErrors.Unavailable]: 503,
  [CoreErrors.Unsupported]: 501,
  [CoreErrors.RateLimited]: 429,
  [CoreErrors.TimeoutUnreached]: 503,
  [CoreErrors.TimeoutPending]: 504,
  [CoreErrors.Cancelled]: 499,
  [CoreErrors.Paused]: 503,
  [CoreErrors.Destroyed]: 503,
  [CoreErrors.NoRoute]: 404,
  [CoreErrors.Internal]: 500,
}
