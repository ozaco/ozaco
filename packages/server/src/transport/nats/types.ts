import type { BrokerContext, TransportOptions } from 'server:core'
import type { BoundLogger } from 'server:utils'
import type { Scope, Task } from 'std:effect'
import type { Result } from 'std:result'

import type { JetStreamClient, JetStreamManager } from '@nats-io/jetstream'
import type { ConnectionOptions, NatsConnection } from '@nats-io/nats-core'

export interface NatsTransportOptions extends TransportOptions {
  /**
   * FULL `@nats-io/nats-core` v3 `ConnectionOptions` passthrough — auth (user/pass/token/
   * authenticator), tls, the whole reconnect family, pingInterval, noEcho, inboxPrefix, … —
   * handed to the injectable `natsImpl.connect` verbatim.
   */
  readonly connection?: ConnectionOptions | undefined
  /** Sugar for `connection.servers`. */
  readonly servers?: string | readonly string[] | undefined
  /** First token of every subject (`<prefix>.v1.…`) and of the stream names. Default `'ozaco'`. */
  readonly subjectPrefix?: string | undefined
  /**
   * Namespaces the per-service durable consumers (`<group>_<service>`). Every instance of a
   * service MUST share one group — the RPC stream is a workqueue, which allows exactly one
   * consumer per subject. Default `'default'`.
   */
  readonly queueGroup?: string | undefined
  readonly jetstream?: Nats.JetStreamOptions | undefined
  readonly events?: Nats.EventsOptions | undefined
}

/** The cold wire/config surface of the NATS carrier, grouped (`Result.Failure` pattern). */
export namespace Nats {
  /**
   * The injectable connection factory behind the transport (the `natsImpl` context). Defaults to
   * `connect` from `@nats-io/transport-node`; swap it for fakes in tests or for
   * `@nats-io/transport-deno` on Deno.
   */
  export interface ImplLike {
    connect(options?: ConnectionOptions): Promise<NatsConnection>
  }

  export interface JetStreamOptions {
    /** Replicas for every provisioned stream (min 1, max 5). Default `1`. */
    readonly replicas?: number | undefined
    /** RPC workqueue `max_age` in ms — dispatches nobody consumed expire. Default `60_000`. */
    readonly rpcMaxAgeMs?: number | undefined
    /** LANE stream `max_age` in ms — the ABANDONED-lane sweeper (frames a reader never acked). Default `300_000`. */
    readonly laneMaxAgeMs?: number | undefined
    /**
     * LANE stream `max_bytes` — the backpressure window. The LANE workqueue rejects publishes once
     * this many unacked bytes accumulate (`discard: new`), parking slow-consumer producers.
     * Default `67_108_864` (64 MiB).
     */
    readonly laneMaxBytes?: number | undefined
    /**
     * How long a lane pump keeps parking-and-retrying against a full LANE stream before it gives
     * up with `NatsErrors.LaneFull`. Default `30_000`.
     */
    readonly laneFullTimeoutMs?: number | undefined
    /** OUTCOME stream `max_age` in ms — how long `outcome(cid)` stays answerable. Default `600_000`. */
    readonly outcomeTtlMs?: number | undefined
    /** Storage backend for every provisioned stream. Default `'memory'`. */
    readonly storage?: 'memory' | 'file' | undefined
  }

  /** {@link JetStreamOptions} with every default applied. */
  export interface JetStreamResolved {
    readonly replicas: number
    readonly rpcMaxAgeMs: number
    readonly laneMaxAgeMs: number
    readonly laneMaxBytes: number
    readonly laneFullTimeoutMs: number
    readonly outcomeTtlMs: number
    readonly storage: 'memory' | 'file'
  }

  export interface EventsOptions {
    /**
     * Persist BROADCASTS in a `<P>_EVENT` stream and deliver them through a per-queue-group durable
     * consumer (`<queueGroup>_events`, `DeliverPolicy.New`, explicit ack). Restart-safe and
     * at-least-once WITHIN the group: one member consumes each broadcast, missed events replay on
     * the next attach, and bus handlers MAY see redeliveries. `emit` stays core pub/sub
     * (at-most-once) in both modes. Default `false`.
     */
    readonly durable?: boolean | undefined
    /** EVENT stream `max_age` in ms — how far back a late-attaching group can catch up. Default `86_400_000`. */
    readonly maxAgeMs?: number | undefined
    /** EVENT stream storage. Default `'file'` (durability is the point). */
    readonly storage?: 'memory' | 'file' | undefined
  }

  /** {@link EventsOptions} with every default applied. */
  export interface EventsResolved {
    readonly durable: boolean
    readonly maxAgeMs: number
    readonly storage: 'memory' | 'file'
  }

  /** Whitebox counters for tests/ops — this node's lane pump activity. */
  export interface Diagnostics {
    /** Publishes that parked (stream full) and retried. */
    laneRetries: number
    /** Failure tags of pumps that gave up (lane-full timeouts, publish faults, truncated sources). */
    readonly laneFailures: string[]
  }

  /** The prefix-bound subject map (see `internal/subjects.ts` for the naming decisions). */
  export interface Subjects {
    readonly rpc: (service: string) => string
    readonly rpcWild: string
    readonly reply: (cid: string) => string
    readonly cancel: (cid: string) => string
    readonly lane: (cid: string, lane: string) => string
    readonly laneWild: string
    readonly event: (name: string) => string
    readonly eventWild: string
    readonly outcome: (cid: string) => string
    readonly outcomeWild: string
  }

  export interface StreamNames {
    readonly rpc: string
    readonly lane: string
    readonly outcome: string
    /** Provisioned only with `events.durable`. */
    readonly event: string
  }

  export interface Context {
    /** The transport ENTRY name in the routing table (default `nats`). */
    readonly name: string
    readonly priority: number
    readonly prefix: string
    readonly queueGroup: string
    readonly scope: Scope
    readonly log: BoundLogger
    readonly broker: BrokerContext
    readonly nc: NatsConnection
    readonly js: JetStreamClient
    readonly jsm: JetStreamManager
    readonly subjects: Subjects
    readonly streams: StreamNames
    readonly jetstream: JetStreamResolved
    readonly events: EventsResolved
    readonly diagnostics: Diagnostics
    /** Positive `hosts()` answers: durable name → cache expiry epoch ms. */
    readonly hostsCache: Map<string, number>
    /** Running owner consume loops keyed by service name (tasks are boxed — they never fail). */
    readonly owners: Map<string, Task<Result<void>>>
  }
}
