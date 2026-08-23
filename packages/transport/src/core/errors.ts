import { createTags } from 'std:shared'

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
 */
export const TransportErrors = createTags(
  'transport',

  'connection',
  'timeout',
  'no-responders',
  'payload-too-large',
  'lane-full',
  'closed',
  'unsupported',
  'configuration',
  'encoding',
)
