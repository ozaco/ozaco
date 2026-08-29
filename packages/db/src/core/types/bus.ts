import type { Operation } from 'std:effect'
import type { EventEmitter } from 'std:event'

import type { TransportDef } from 'transport:core'

import type { Change } from './change'

/**
 * The `DbBus` plugin surface — the multi-node layer on top of the node's local
 * {@link Change.Bus}. One plugin, any network: it ships envelopes through an `@ozaco/transport`
 * plugin (`install(DbBus, { transport: NatsTransport })`) and emits what the peers ship back.
 */
export namespace Bus {
  export interface Options {
    /** The transport plugin to carry envelopes (pinned: `transport.actions.*`). Default: the
     * most recently installed transport (routed `Transport.actions.*`). Install it BEFORE the
     * bus. */
    readonly transport?: TransportDef | undefined

    /** The transport topic envelopes travel on (under the transport's application prefix).
     * Default `'db.change'`. */
    readonly topic?: string | undefined
  }

  /** What `install(DbBus)` resolves: the carrier's identity + the emitter foreign envelopes
   * arrive on (`events.emit('change', envelope)` for every message from a peer). */

  export interface Context {
    /** the carrier's name (`'nats'`, `'memory'`, …) as its install resolved it. */
    readonly transportName: string
    readonly topic: string
    readonly events: EventEmitter<Events>

    /** the carrier itself, bound at install (pinned or routed). */
    readonly transport: TransportDef
  }

  /** One shipment between nodes: a node's committed writes under a monotonic per-origin `seq`
   * (peers dedupe and detect gaps with it) and the transaction they belong to. */

  export interface Envelope {
    readonly origin: string
    readonly seq: number

    /** group id — the transaction's token, or the single change's own token. */
    readonly tx: string
    readonly events: readonly Change.BusEvent[]

    /** free-form correlation data the writer attached (`withBusMeta`) — e.g. the request id
     * that caused the writes. Never interpreted by the hub. */
    readonly meta?: Readonly<Record<string, unknown>> | undefined
  }

  /** The event map of transport endpoints and the local bus: envelopes in, envelopes out. */
  export type Events = {
    change: [envelope: Envelope]
  }

  export interface OutboxOptions {
    /** Envelopes the outbox may hold before the oldest are dropped (peers heal by replaying the
     * change log — nothing is lost, only a wake-up is delayed). Default 4096. */
    readonly maxPending?: number | undefined

    /** How long the closing scope waits for the outbox to drain. Default 1000. */
    readonly drainTimeoutMs?: number | undefined
  }

  /** Counters `Db.actions.busStats()` reports. */
  export interface Stats {
    /** envelopes handed to the transports. */
    readonly published: number

    /** transport publishes that failed (the writes themselves were unaffected). */
    readonly failed: number

    /** envelopes dropped by an overflowing outbox. */
    readonly coalesced: number

    /** foreign envelopes received. */
    readonly received: number

    /** duplicates dropped by `(origin, seq)`. */
    readonly deduped: number

    /** sequence gaps (or first sight of an origin) that triggered a replay. */
    readonly gaps: number

    /** change-log rows applied by replays (gap heal + polling). */
    readonly replayed: number

    /** replayed rows whose token was OLDER than what was already applied — late commits the
     * `ts` window caught. */
    readonly windowHits: number

    /** received tokens whose clock was too far ahead to adopt. */
    readonly driftRejected: number

    /** last envelope seen per peer origin. */
    readonly peers: Readonly<Record<string, { readonly seq: number; readonly at: number }>>
  }

  export interface Actions {
    /** Ship one envelope to the peers through the carrier. */
    publish(envelope: Envelope): Operation<void>
  }
}
