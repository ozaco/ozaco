import type { AnyType } from 'std:shared'

import type { TransportDef } from 'transport:core'

export namespace Redis {
  export interface Options extends TransportDef.CommonOptions {
    /** `redis://…` connection string. */
    readonly url: string
    /** Extra `createClient` options (tls, socket, password, …) merged under `url`. */
    readonly client?: Record<string, unknown> | undefined
    /** Streams used for competing-consumer groups are capped at about this many entries
     * (`XADD MAXLEN ~`). Default 10 000. */
    readonly streamMaxLen?: number | undefined
    /** How long a durable member may hold an entry before another member may claim it
     * (`XAUTOCLAIM` min-idle). Default 30 s. */
    readonly ackWaitMs?: number | undefined
  }

  /** The client factory the transport dials through (injectable for fakes). */
  export interface ImplLike {
    createClient(options: Record<string, unknown>): AnyType
  }

  export interface State {
    /** commands + publishing. */
    readonly client: AnyType
    /** a dedicated connection in subscriber mode. */
    readonly subscriber: AnyType
    readonly prefix: string
    readonly streamMaxLen: number
    readonly ackWaitMs: number
    status: 'connected' | 'reconnecting' | 'closed'
    drained: boolean
  }
}
