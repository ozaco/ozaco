import type { Queue } from 'std:effect'

import type { TransportDef } from 'transport:core'

export namespace Memory {
  export interface Options extends TransportDef.CommonOptions {
    /** Share one link between several installs (different scopes) so they hear each other —
     * the in-process stand-in for a broker. Default: a private link per install. */
    readonly link?: Link | undefined
    /** Pretend payloads above this size are rejected (`transport.payload-too-large`). */
    readonly maxPayloadBytes?: number | undefined
  }

  /** One live subscription on the link (subjects are prefixed, as on a broker). */
  export interface Subscriber {
    readonly pattern: string
    readonly group: string | undefined
    readonly queue: Queue<TransportDef.Raw, void>
  }

  /** One message a durable consumer holds until it is acked. */
  export interface Held {
    readonly seq: number
    readonly raw: TransportDef.Raw
  }

  /** A durable consumer: the broker-side memory of a `durable` name — what was published on
   * its pattern since it was created and not yet acked, and the members currently pulling. */
  export interface Durable {
    readonly pattern: string
    seq: number
    /** waiting for a member, oldest first. */
    readonly pending: Held[]
    /** taken by a member, not yet acked (→ back to `pending` on nak / member loss). */
    readonly inflight: Map<number, Held>
    readonly members: Set<Queue<Held, void>>
    cursor: number
  }

  /** How an unreliable link misbehaves (each receiver rolls its own fate per delivery). */
  export interface ChaosRules {
    /** probability a receiver never gets the message. Default 0.1. */
    readonly dropRate: number
    /** probability a receiver gets it twice. Default 0.1. */
    readonly duplicateRate: number
    /** every delivery waits a uniform random 0..maxDelayMs (so messages reorder). Default 50. */
    readonly maxDelayMs: number
  }

  export interface ChaosCounters {
    delivered: number
    dropped: number
    duplicated: number
  }

  /** A seeded, deterministic source of misfortune attached to a link. */
  export interface Chaos {
    readonly seed: number
    readonly rules: ChaosRules
    readonly random: () => number
    readonly counters: ChaosCounters
  }

  export interface LinkOptions {
    /** Make the link unreliable: delay, reorder, duplicate and drop deliveries to plain and
     * grouped subscribers (durables stay exact — the broker's memory is not the network). */
    readonly chaos?: ({ readonly seed: number } & Partial<ChaosRules>) | undefined
  }

  /** The shared in-process "broker": every subscriber on it sees every publish that matches. */
  export interface Link {
    readonly chaos: Chaos | null
    readonly subscribers: Set<Subscriber>
    /** round-robin cursors per group. */
    readonly cursors: Map<string, number>
    /** durable consumers by (prefixed) name. */
    readonly durables: Map<string, Durable>
    /** every install on the link (so `setMemoryStatus` can flip them together). */
    readonly states: Set<State>
  }

  export interface State {
    readonly link: Link
    readonly prefix: string
    readonly maxPayloadBytes: number | null
    status: TransportDef.Status
    /** publishes made while `reconnecting`, delivered on the next `connected`. */
    readonly outbox: TransportDef.Raw[]
    readonly watchers: Set<Queue<TransportDef.Status, void>>
  }
}
