import type { TransportDef } from 'server:core'

import type { NatsConnection, Subscription as NatsSubscription } from 'nats'

export namespace Nats {
  export interface Options extends TransportDef.Options {
    servers?: string | string[]
    subjectPrefix?: string
    queueGroup?: string
    requestTimeoutMs?: number
  }

  export interface Context extends TransportDef.Context {
    connection: NatsConnection
    prefix: string
    queueGroup?: string
    requestTimeoutMs: number
    subscriptions: Map<string, NatsSubscription>
  }

  export interface WireSuccess {
    _t: '__success__'
    value: unknown
  }

  export interface WireFailure {
    _t: '__failure__'
    error: string
    message: string
    causes?: string[]
  }

  export type Wire = WireSuccess | WireFailure
}
