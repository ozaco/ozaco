import type { Flow, Operation } from 'std:effect'
import type { Result } from 'std:result'

import type { TransportDef } from './transport'

/** Internal helper shapes the core passes around — collected here so no type lives outside
 * `types/`. */
export namespace Helpers {
  /**
   * What the lane helpers take internally: the public options plus the wiring only core uses.
   * Neither member is part of the `Transport` surface — they exist so the package plane can run
   * a lane on the backend's ephemeral plane and time its announcement.
   */
  export interface LaneSetup extends TransportDef.LaneOptions {
    /** Ride the backend's ephemeral plane: the parcel sideband of a request stores nothing (on
     * JetStream it stays on core NATS instead of landing in the stream). */
    readonly transient?: boolean | undefined
    /** Run once the producer's credit subscription is live and BEFORE it waits for credit — the
     * first moment the other side may be told to attach. */
    readonly ready?: (() => Operation<void>) | undefined
  }

  /** A lane frame as decoded from a raw message. */
  export type Frame =
    | { readonly kind: 'data'; readonly seq: number; readonly raw: TransportDef.Raw }
    | { readonly kind: 'chunk'; readonly seq: number; readonly raw: TransportDef.Raw }
    | { readonly kind: 'end'; readonly seq: number; readonly raw: TransportDef.Raw }
    | { readonly kind: 'fail'; readonly seq: number; readonly raw: TransportDef.Raw }

  /** The credit a lane consumer grants: how many more frames the producer may send. */
  export interface Credit {
    readonly n: number
  }

  /** A credit frame as the producer reads it off the wire. */
  export interface CreditFrame extends Credit {
    /** true for the repeated attach announcements; a producer honours only the first of those. */
    readonly initial: boolean
  }

  /** The producer side of one lane: how frames leave. */
  export interface Producer {
    /** Publish one value frame (raw `Uint8Array` → `chunk`). */
    send(value: unknown): Operation<void>
    /** Publish the terminal frame with the close value. */
    end(close: unknown): Operation<void>
    /** Publish a terminal failure frame. */
    abort(failure: Result.Failure<unknown>): Operation<void>
    /** Scope teardown: if no terminal frame went out (the producer was halted mid-lane), tell
     * the consumer the lane died instead of leaving it waiting forever. Best-effort. */
    leave(): Operation<void>
  }

  /** One chunked payload being reassembled on the receiving side. */
  export interface Assembly {
    readonly parts: (Uint8Array | undefined)[]
    readonly headers: TransportDef.Headers
    readonly topic: string
    readonly seq: string | undefined
    received: number
    readonly startedAt: number
  }

  /** What the plane factory works with — the driver plus the resolved lane defaults. */
  export interface Runtime {
    readonly driver: TransportDef.Driver
  }

  /** One request as the package plane receives it. */
  export interface Request<TArgs> {
    readonly topic: string
    readonly args: TArgs
    readonly options?: TransportDef.RequestOptions | undefined
  }

  /** One served topic as the package plane receives it (`group` already namespaced). */
  export interface Service<TArgs, TResult> {
    readonly topic: string
    readonly handler: TransportDef.Handler<TArgs, TResult>
    readonly group?: string | undefined
  }

  /** One lane publication as the flow plane receives it. */
  export interface Pipe<T, TClose> {
    readonly topic: string
    readonly source: Flow<T, TClose>
    readonly options?: TransportDef.LaneOptions | undefined
  }

  /** Where one answer goes: the reply topic the backend handed out, plus the exchange's
   * correlation id (the parcel sideband of an oversize reply is addressed by it). */
  export interface Reply {
    readonly topic: string
    readonly cid: string | undefined
    /** how long an oversize reply's sideband stays open for this caller (from its `oz-wait`). */
    readonly waitMs: number
  }

  /** What one answer carries: the encoded payload and the headers that describe it. */
  export interface Answer {
    readonly data: Uint8Array
    readonly headers: TransportDef.Headers
  }

  /** One side of an exchange's sideband: whose it is, and which way it runs. */
  export interface Sideband {
    readonly cid: string | undefined
    readonly direction: 'in' | 'out'
  }

  /** One parcel leaving: the lane it takes, the bytes, how long its peer is held open, and what
   * to run the moment the lane is live (the message that tells the peer to attach). */
  export interface Parcel {
    readonly topic: string
    readonly data: Uint8Array
    readonly waitMs: number
    readonly ready?: (() => Operation<void>) | undefined
  }

  export interface WriteCommand {
    readonly chunk: Uint8Array | null
    readonly failure: Result.Failure<unknown> | null
    readonly settle: (outcome: Result.Failure<unknown> | null) => void
  }
}
