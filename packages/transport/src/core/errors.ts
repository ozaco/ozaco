import { createTags } from 'std:shared'

import { noResponders, timedOut } from './internal/faults'

/**
 * Transport failure tags — only for CARRYING problems. A responder's own failure travels through
 * the package plane with its original tag/message/causes and is re-raised as-is.
 *
 * - `connection` — the backend could not be reached / dropped
 * - `timeout` — no reply (package) or no consumer (lane) within the deadline
 * - `no-responders` — a request reached nobody
 * - `payload-too-large` — over the backend's `maxPayloadBytes`
 * - `lane-full` — producer could not get credit in time
 * - `closed` — used after `drain()` / scope teardown
 * - `unsupported` — the installed transport lacks the capability
 * - `configuration` — bad install wiring
 * - `encoding` — a payload could not be (de)coded / a frame was malformed
 *
 * `timeout` and `no-responders` also say which backend client error they stand for (a
 * `TimeoutError`, a NATS `NoRespondersError` — see `internal/faults`): a client rejection is
 * folded into them (`asFailure(error, TransportErrors)`), the client error kept as the failure's
 * `raw`.
 */
export const TransportErrors = createTags(
  'transport',

  'connection',
  ['timeout', timedOut],
  ['no-responders', noResponders],
  'payload-too-large',
  'lane-full',
  'closed',
  'unsupported',
  'configuration',
  'encoding',
)
