import type {
  ActionSignal,
  BrokerContext,
  DisconnectMode,
  Reply,
  TransportOptions,
  Wire,
} from 'server:core'
import type { BoundLogger } from 'server:utils'
import type { Helpers, Queue, Scope, Task } from 'std:effect'
import type { Result } from 'std:result'

/** Install options of the worker carrier. `script` present → host role; absent → child role. */
export interface WorkerTransportOptions extends TransportOptions {
  /** Worker entry script — the HOST spawns `count` workers running it. Omit for the CHILD role. */
  readonly script?: string | URL | undefined
  /** How many workers to spawn (host role only). */
  readonly count?: number | undefined
}

/** Which end of the port this instance is. */
export type WorkerRole = 'host' | 'child'

/** The cold wire/state surface of the worker carrier, grouped (`Result.Failure` pattern). */
export namespace WorkerWire {
  /** A `reply` envelope kept for `idempotencyKey` replay (only value replies are replayable). */
  export type CachedReply = Extract<Wire.Envelope, { k: 'reply' }>

  /**
   * Carrier-internal readiness handshake — NOT part of the core envelope union. The child posts it
   * once its message listener is attached, so the host never writes into a listener-less port.
   */
  export interface OnlineMessage {
    readonly k: 'online'
    readonly node: string
  }

  /** Everything this carrier moves over a port. */
  export type PortMessage = Wire.Envelope | OnlineMessage

  /** The minimal port surface both runtimes (bun Web Worker, node worker_threads) reduce to. */
  export interface Port {
    post(message: unknown): void
    terminate(): void
  }

  /** An in-flight OUTGOING dispatch awaiting its reply envelopes. */
  export interface PendingDispatch {
    readonly settle: (result: Result<Reply>) => void
    readonly acked: () => void
  }

  /** An in-flight INCOMING dispatch (owner side), addressable by `cancel`/`abandoned` envelopes. */
  export interface RunningDispatch {
    task: Task<unknown> | undefined
    cancelled: boolean
    /** Reconstructed input planes fed by `in:*` lane envelopes (absent on plain dispatches). */
    inputs: InputBridge | undefined
    readonly signal: FireableSignal
    readonly mode: DisconnectMode
  }

  /** An {@link ActionSignal} the carrier fires when a `cancel`/`abandoned` envelope arrives. */
  export interface FireableSignal extends ActionSignal {
    fire(): void
  }

  /** A tiny TTL'd map — the owner-side reply cache backing `idempotencyKey` dedupe. */
  export interface TtlCache<T> {
    get(key: string): T | undefined
    set(key: string, value: T): void
  }

  /** Producer-side ledger of one flowing lane — parks at `LANE_WINDOW` in flight until credit. */
  export interface LaneSender {
    readonly cid: string
    readonly lane: string
    /** Items posted so far (doubles as the next `seq`). */
    sent: number
    /** Cumulative consumer grant, raised by `lane-credit` envelopes. */
    granted: number
    /** The parked producer's gate — resolved by credit, rejected when the peer dies. */
    gate: Helpers.WithResolvers<void> | undefined
  }

  /** Consumer-side ledger of one queue-backed lane (output stream, or the `in:stream` plane). */
  export interface LaneReceiver {
    readonly cid: string
    readonly lane: string
    readonly queue: Queue<unknown, unknown>
    /** Cumulative items consumed — posted back as the credit grant every `LANE_CREDIT_STEP`. */
    consumed: number
    /** Items received but not yet consumed (diagnostics only). */
    buffered: number
  }

  /** One reconstructed input plane on the owner side (an `in:*` lane sink). */
  export interface InputPlane {
    /** Feed one input-lane envelope (data / end / error) into the plane's sink. */
    readonly feed: (envelope: Extract<Wire.Envelope, { k: 'lane' }>) => void
    /** Close the sink with a failure (dead peer, abandoned caller). */
    readonly kill: (failure: Result.Failure<string>) => void
  }

  /** Owner-side bridge rebuilding a dispatch's input planes from `in:*` lane envelopes. */
  export interface InputBridge {
    /** What `invokeLocal` receives — keyed by `DataType` plane name. */
    readonly sources: Map<string, unknown>
    /** Envelope sinks keyed by full lane name (`in:multistream`, `in:stream`). */
    readonly planes: Map<string, InputPlane>
  }

  /** One remote end: a spawned worker (host role) or the parent port (child role). */
  export interface Peer {
    readonly index: number
    port: Port
    online: boolean
    dead: boolean
    /** Envelopes queued until the peer reports `online`. */
    readonly outbox: PortMessage[]
    readonly pending: Map<string, PendingDispatch>
    readonly streams: Map<string, LaneReceiver>
    /** Producer ledgers keyed by `cid#lane` — every flowing lane this side is pumping. */
    readonly senders: Map<string, LaneSender>
    readonly running: Map<string, RunningDispatch>
  }

  /** The per-install carrier state (no module globals — everything lives here). */
  export interface Context {
    readonly name: string
    readonly role: WorkerRole
    readonly broker: BrokerContext
    readonly scope: Scope
    readonly log: BoundLogger
    readonly peers: Peer[]
    readonly replies: TtlCache<CachedReply>
    /** Round-robin cursor over live peers. */
    cursor: number
  }
}
