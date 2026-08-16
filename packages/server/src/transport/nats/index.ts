/**
 * `server:transport/nats` — the NATS carrier on the `@nats-io` v3 split client.
 *
 * - full `ConnectionOptions` passthrough (`options.connection`), injectable via the `natsImpl`
 *   context (fakes in tests, `@nats-io/transport-deno` on Deno);
 * - JetStream mandatory: `<P>_RPC` workqueue (one shared durable per service — cluster-wide load
 *   balancing + `msgID` idempotency dedupe), `<P>_LANE` workqueue (`discard: new`,
 *   `laneMaxBytes`) for stream replies AND `in:<DataType>` input planes — full publishes park the
 *   producer, real end-to-end backpressure — and `<P>_OUTCOME` for the fulfillment model's
 *   owner-side truth;
 * - events ride core pub/sub (at-most-once); with `events.durable` broadcasts persist in
 *   `<P>_EVENT` and each queue group consumes them at-least-once through a shared durable;
 * - replies/acks and cancel/abandoned control envelopes ride per-cid core inboxes;
 * - byte lanes are framed natively (raw payload + headers), never through the JSON codec.
 */
export * from './definition'
export * from './errors'
export * from './utils/context'
export type * from './types'
/** Re-exported so consumers can type the full passthrough without importing the nats packages. */
export type { ConnectionOptions, NatsConnection } from '@nats-io/nats-core'
