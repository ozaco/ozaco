import { createTags } from 'std:shared'

/**
 * The server error taxonomy — every failure crossing a boundary (edge, carrier, plugin, handler)
 * is a Result failure carrying one of these tags (or a service-defined tag) plus breadcrumb
 * causes (`action:… req:… span:… where:…`); nothing throws.
 *
 * Fulfillment model:
 * - `timeout-unreached` — nobody took the dispatch (no responder / never acknowledged). Safe to
 *   retry.
 * - `timeout-pending` — a handler took it but no reply arrived in time; the outcome is unknown.
 *   Do not retry blindly — reconcile via `Outcomes` or use an `idempotencyKey`.
 */
export const ServerErrors = createTags(
  'server',
  'configuration',
  'validation',
  'bad-request',
  'unauthorized',
  'forbidden',
  'not-found',
  'conflict',
  'payload-too-large',
  'unavailable',
  'unsupported',
  'rate-limited',
  'timeout-unreached',
  'timeout-pending',
  'cancelled',
  'paused',
  'internal',
)

/** Failure tag → HTTP status (a service may override per action via `errors`). */
export const STATUS_OF: Readonly<Record<string, number>> = {
  [ServerErrors.Validation]: 400,
  [ServerErrors.BadRequest]: 400,
  [ServerErrors.Unauthorized]: 401,
  [ServerErrors.Forbidden]: 403,
  [ServerErrors.NotFound]: 404,
  [ServerErrors.Conflict]: 409,
  [ServerErrors.PayloadTooLarge]: 413,
  [ServerErrors.RateLimited]: 429,
  [ServerErrors.Unsupported]: 501,
  [ServerErrors.Unavailable]: 503,
  [ServerErrors.Paused]: 503,
  [ServerErrors.TimeoutUnreached]: 504,
  [ServerErrors.TimeoutPending]: 504,
  [ServerErrors.Cancelled]: 499,
  [ServerErrors.Configuration]: 500,
  [ServerErrors.Internal]: 500,

  // the database's own taxonomy, as handlers usually let it through
  'db.validation': 400,
  'db.not-found': 404,
  'db.data-integrity': 409,
  'db.unique': 409,
  'db.foreign-key': 400,
  'db.not-null': 400,
  'db.check': 400,
  'db.conflict': 409,
  'db.cursor': 400,
  'db.unsupported': 501,
  'db.unavailable': 503,
}
