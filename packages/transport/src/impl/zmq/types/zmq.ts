import type { Operation, Queue } from 'std:effect'

import type { TransportDef } from 'transport:core'
import type { Memory } from 'transport:impl/memory'

import type { Helpers } from './helpers'

export namespace Zmq {
  /** A zmq endpoint: `tcp://host:port` (`*` = every interface; port `0` = ephemeral when
   * binding), `ipc://path` (a unix domain socket) or `inproc://name` (this process only). */
  export type Endpoint = string

  /** Be the hub: bind here (ZMTP ROUTER) and serve every peer that connects; the install itself
   * talks to its hub in process. */
  export interface BindOptions extends TransportDef.CommonOptions {
    readonly bind: Endpoint
    readonly connect?: undefined
    /** Liveness of every peer's connection; `false` turns the hub's pings off (it still answers
     * its peers'). */
    readonly heartbeat?: Heartbeat | false | undefined
    /** Share one in-process link between hubs of this process (tests; several hubs in one
     * node). Default: a private link per hub. */
    readonly link?: Memory.Link | undefined
  }

  /** Join a hub: connect here (ZMTP DEALER). Redials with backoff for as long as the install
   * lives — a hub may restart. */
  export interface ConnectOptions extends TransportDef.CommonOptions {
    readonly connect: Endpoint
    readonly bind?: undefined
    /** How long the FIRST dial may keep failing before the install fails
     * `transport.connection` (zmq itself would wait forever). Default 5000. */
    readonly connectTimeoutMs?: number | undefined
    /** How long a publish / subscribe made while the hub is down waits for it to come back
     * before failing `transport.connection` (a DEALER would block on its HWM forever). Also
     * the ceiling under which a `request` made while down waits — its own `timeoutMs` starts
     * only once it is on the wire. Default 5000. */
    readonly offlineTimeoutMs?: number | undefined
    /** Liveness of the connection to the hub; `false` turns this side's pings off. */
    readonly heartbeat?: Heartbeat | false | undefined
  }

  export type Options = BindOptions | ConnectOptions

  /** Liveness of a ZMTP connection: a `PING` every `intervalMs`, and a peer that sent nothing
   * for `timeoutMs` is gone — the connection closes (hub side: its subscriptions end; peer side:
   * a redial). What a half-open TCP socket never tells. */
  export interface Heartbeat {
    /** Default 5000. */
    readonly intervalMs?: number | undefined
    /** Default 15 000 (≥ `intervalMs`). */
    readonly timeoutMs?: number | undefined
  }

  /** The install's end of the hub protocol, however the hub is reached (in process, or over
   * ZMTP with redials). */
  export interface Peer {
    /** Send one command that is answered (`PUB`, `SUB`); resolves the `OK` answer's frames
     * after the id, fails with the `ERR` answer's tag and message. */
    call(frames: readonly Uint8Array[]): Operation<Uint8Array[]>
    /** Send one command nobody answers (`UNSUB`, `ACK`, `NAK`). */
    cast(frames: readonly Uint8Array[]): Operation<void>
    /** Say `BYE`, close the connection, fail what waits, end every subscription; idempotent.
     * Also runs when the install's scope ends. */
    close(): Operation<void>
    /** The install's live subscriptions by id — the hub's `MSG`s are routed to them, and
     * each one is re-announced to a hub that reconnected. */
    readonly subscriptions: Map<string, Helpers.Subscription>
  }

  export interface State {
    readonly prefix: string
    /** The endpoint bound (hub) or dialled (peer), as given. */
    readonly endpoint: Endpoint
    /** The hub side's actual address (an ephemeral port resolved); null on a connecting
     * install. */
    readonly bound: Endpoint | null
    readonly peer: Peer
    status: TransportDef.Status
    readonly watchers: Set<Queue<TransportDef.Status, void>>
    drained: boolean
  }
}
