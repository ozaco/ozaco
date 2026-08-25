import type { Queue } from 'std:effect'

import type { TransportDef } from 'transport:core'

export namespace Worker {
  /** What both ends of a worker channel expose: a `Worker` on the main side, `self` (or a
   * `MessagePort`) on the worker side. */
  export interface PortLike {
    postMessage(message: unknown, transfer?: readonly ArrayBuffer[]): void
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
    removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  }

  export interface Options extends TransportDef.CommonOptions {
    /** The other end of the channel. */
    readonly port: PortLike
  }

  /** The message shape crossing the channel (structured-cloned). */
  export interface Frame {
    readonly oz: 'transport'
    readonly topic: string
    readonly data: Uint8Array
    readonly headers: TransportDef.Headers
  }

  export interface Subscriber {
    readonly pattern: string
    readonly queue: Queue<TransportDef.Raw, void>
  }

  export interface State {
    readonly port: PortLike
    readonly prefix: string
    readonly subscribers: Set<Subscriber>
    status: TransportDef.Status
  }
}
