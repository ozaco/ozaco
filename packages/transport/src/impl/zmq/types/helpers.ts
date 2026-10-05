import type { Operation, Queue, Scope } from 'std:effect'

import type { Zmq } from './zmq'

/** The shapes the zmq impl passes around inside itself. */
export namespace Helpers {
  /** What the ZMTP decoder reads off the bytes. `more` never leaves the decoder. */
  export type ZmtpEvent =
    | { readonly t: 'greeting'; readonly minor: number }
    | { readonly t: 'command'; readonly name: string; readonly data: Uint8Array }
    | { readonly t: 'message'; readonly frames: Uint8Array[] }
    | { readonly t: 'more' }
    | { readonly t: 'error'; readonly reason: string }

  export interface Decoder {
    feed(chunk: Uint8Array): ZmtpEvent[]
  }

  /** The two ends of one connection as the hub protocol sees them: multipart messages in both
   * directions. Over ZMTP it is a handshaken socket; in process it is a pair of queues. */
  export interface Link {
    send(frames: readonly Uint8Array[]): Operation<void>
    /** Inbound messages; closes when the other end is gone. */
    readonly messages: Queue<Uint8Array[], void>
    /** Tear the connection down (`messages` closes). */
    close(): Operation<void>
  }

  /** The ZMTP socket roles a link is opened as. */
  export type SocketType = 'DEALER' | 'ROUTER'

  /** A resolved {@link Zmq.Heartbeat}; null = no pings from this side. */
  export type HeartbeatSettings = {
    readonly intervalMs: number
    readonly timeoutMs: number
  } | null

  /** One hub: the scope its peers are served in (an in-process peer attaches through it —
   * `within(scope, …)` — so the hub's memory install is in reach) and where it is bound. */
  export interface Hub {
    readonly scope: Scope
    /** The endpoint actually bound (an ephemeral tcp port resolved). */
    readonly bound: Zmq.Endpoint
  }

  /** One live subscription of an install: where its deliveries go. */
  export interface Subscription {
    readonly queue: Queue<Uint8Array[], void>
    /** The `SUB` frames that opened it — re-sent to a hub that reconnected. */
    readonly announce: readonly Uint8Array[]
  }

  /** The answer a `call` waits for. */
  export interface Pending {
    resolve(frames: Uint8Array[]): void
    reject(tag: string, message: string): void
  }
}
