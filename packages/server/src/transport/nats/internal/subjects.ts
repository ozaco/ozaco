// oxlint-disable import/exports-last
import type { Nats } from '../types'

/**
 * SUBJECT LAYOUT (all under one sanitized `<p>` prefix, wire-spec v1):
 *
 * - `rpc`     `<p>.v1.rpc.<service>`      — JetStream (`<P>_RPC`, workqueue). ONE subject per
 *   service; load balancing comes from the single shared durable consumer, not queue groups.
 * - `reply`   `<p>.v1.reply.<cid>`        — core NATS. Per-dispatch inbox (ack/reply envelopes).
 * - `cancel`  `<p>.v1.cancel.<cid>`       — core NATS. Caller-abandonment ping to the owner.
 * - `lane`    `<p>.v1.lane.<cid>.<lane>`  — JetStream (`<P>_LANE`, workqueue + `discard: new`).
 *   Reply-stream frames on lane `0`, input planes on `in_<DataType>` lanes.
 * - `event`   `<p>.v1.event.<name>`       — core NATS pub/sub fanout. DELIVERY GUARANTEE:
 *   at-most-once — events are invalidation-style signals, not durable facts. With
 *   `events.durable` the same subjects are ALSO captured by `<P>_EVENT` and broadcasts ride a
 *   per-queue-group durable consumer (at-least-once within the group).
 * - `outcome` `<p>.v1.outcome.<cid>`      — JetStream (`<P>_OUTCOME`, limits,
 *   `max_msgs_per_subject: 1`). Owner-side truth for `outcome(cid)` reconciliation.
 */

const UNSAFE_TOKEN = /[^0-9A-Za-z_-]/gu
const UNSAFE_EVENT = /[^0-9A-Za-z._-]/gu

/** One valid subject token: anything outside `[0-9A-Za-z_-]` becomes `_`. */
export const sanitizeToken = (raw: string): string => raw.replace(UNSAFE_TOKEN, '_') || '_'

/** Event names keep their dots (multi-token subjects); wildcards/spaces become `_`. */
const sanitizeEventName = (raw: string): string => raw.replace(UNSAFE_EVENT, '_') || '_'

/** The shared durable consumer of one service (namespaced by the queue group). */
export const durableOf = (queueGroup: string, service: string): string =>
  `${sanitizeToken(queueGroup)}_${sanitizeToken(service)}`

/** The durable BROADCAST consumer one queue group shares on the `<P>_EVENT` stream. */
export const eventsDurableOf = (queueGroup: string): string => `${sanitizeToken(queueGroup)}_events`

export const createSubjects = (rawPrefix: string): Nats.Subjects => {
  const p = sanitizeToken(rawPrefix)

  return {
    rpc: service => `${p}.v1.rpc.${sanitizeToken(service)}`,
    rpcWild: `${p}.v1.rpc.>`,
    reply: cid => `${p}.v1.reply.${sanitizeToken(cid)}`,
    cancel: cid => `${p}.v1.cancel.${sanitizeToken(cid)}`,
    lane: (cid, lane) => `${p}.v1.lane.${sanitizeToken(cid)}.${sanitizeToken(lane)}`,
    laneWild: `${p}.v1.lane.>`,
    event: name => `${p}.v1.event.${sanitizeEventName(name)}`,
    eventWild: `${p}.v1.event.>`,
    outcome: cid => `${p}.v1.outcome.${sanitizeToken(cid)}`,
    outcomeWild: `${p}.v1.outcome.>`,
  }
}

export const createStreamNames = (rawPrefix: string): Nats.StreamNames => {
  const p = sanitizeToken(rawPrefix).toUpperCase()

  return { rpc: `${p}_RPC`, lane: `${p}_LANE`, outcome: `${p}_OUTCOME`, event: `${p}_EVENT` }
}
