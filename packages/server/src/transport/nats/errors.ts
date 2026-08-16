import { createTags } from 'std:shared'

/**
 * NATS carrier failure tags:
 * - `configuration` — the transport was installed without a running broker (or unusable options);
 * - `connect` — the initial connection could not be established;
 * - `jetstream` — JetStream is unavailable or a stream could not be provisioned;
 * - `publish` — a JetStream publish (dispatch/lane/outcome) failed;
 * - `consume` — a durable consumer (RPC or events) could not be ensured;
 * - `wire` — a malformed frame arrived on a lane;
 * - `lane-full` — the LANE workqueue stayed at `laneMaxBytes` past `laneFullTimeoutMs` (the
 *   consumer stopped draining) and the parked pump gave up;
 * - `unsupported` — the dispatch needs a capability this carrier does not implement (socket
 *   input planes).
 */
export const NatsErrors = createTags(
  'server:transport/nats',
  'configuration',
  'connect',
  'jetstream',
  'publish',
  'consume',
  'wire',
  'lane-full',
  'unsupported',
)
