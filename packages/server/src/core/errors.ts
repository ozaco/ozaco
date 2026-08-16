import { createTags } from 'std:shared'

/**
 * Core failure tags. Every boundary-crossing operation in the server is assumed fallible; failures
 * are always `Result` failures carrying one of these tags (or a service-defined tag) plus a cause
 * chain of trace breadcrumbs — never bare throws.
 *
 * Timeout taxonomy (fulfillment model):
 * - `TimeoutUnreached` — the dispatch was never acknowledged; the handler never started. Retrying
 *   is safe.
 * - `TimeoutPending` — the dispatch was acknowledged but no reply arrived in time; the outcome is
 *   unknown. Do NOT retry blindly — reconcile via `Broker.actions.outcome(cid)` or use an
 *   `idempotencyKey`.
 */
export const CoreErrors = createTags(
  'server:core',
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
  'destroyed',
  'no-route',
  'internal',
)
