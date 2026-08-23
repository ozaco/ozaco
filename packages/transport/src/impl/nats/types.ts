import type { JetStreamClient, JetStreamManager, StreamConfig } from '@nats-io/jetstream'
import type { ConnectionOptions, NatsConnection } from '@nats-io/nats-core'
import type { TransportDef } from 'transport:core'

export namespace Nats {
  export interface Options extends TransportDef.CommonOptions {
    /** Sugar for `connection.servers`. */
    readonly servers?: string | readonly string[] | undefined
    /** Full `@nats-io/nats-core` `ConnectionOptions` passthrough (auth, tls, reconnect family,
     * …) — handed to the injectable `natsImpl.connect` verbatim. */
    readonly connection?: ConnectionOptions | undefined
    /** Where the application's JetStream stream keeps its messages. Default `'file'`. */
    readonly storage?: 'file' | 'memory' | undefined
    /** How long the stream retains a message at most. Default 24 h. */
    readonly maxAgeMs?: number | undefined
    /** Stream size caps (unbounded when omitted). */
    readonly maxBytes?: number | undefined
    readonly maxMsgs?: number | undefined
    /** Stream replicas (clustered servers). Default 1. */
    readonly replicas?: number | undefined
    /** How long a durable member may hold a message before it is redelivered. Default 30 s. */
    readonly ackWaitMs?: number | undefined
    /** How many deliveries a durable message gets before the server gives up on it. Default
     * 10. */
    readonly maxDeliver?: number | undefined
    /** After how long an idle non-durable consumer (plain / group) is removed server-side.
     * Default 60 s. */
    readonly inactiveThresholdMs?: number | undefined
  }

  /** The connection factory the transport dials through (injectable for fakes / other runtimes). */
  export interface ImplLike {
    connect(options: ConnectionOptions): Promise<NatsConnection>
  }

  /** A stream config with its name pinned (what create-or-update needs). */
  export type StreamSpec = Partial<StreamConfig> & { readonly name: string }

  export interface State {
    readonly nc: NatsConnection
    readonly js: JetStreamClient
    readonly jsm: JetStreamManager
    readonly prefix: string
    /** the application's stream (`<PREFIX>`, subjects `<prefix>.>`). */
    readonly stream: string
    readonly ackWaitMs: number
    readonly maxDeliver: number
    readonly inactiveThresholdMs: number
    drained: boolean
  }
}
