import type { TransportDef } from 'server:core'
import type { Scope } from 'std:effect'

import type { NatsConnection, Subscription as NatsSubscription } from 'nats'

export namespace Nats {
  export interface Options extends TransportDef.Options {
    servers?: string | string[]
    subjectPrefix?: string
    queueGroup?: string
    /** How long request/reply waits for a reply. Default 5000ms. Set `0` (or negative) to DISABLE the
     * transport timeout and let the action `TimeoutPolicy` be the sole authority. */
    requestTimeoutMs?: number
  }

  export interface Context extends TransportDef.Context {
    connection: NatsConnection
    prefix: string
    queueGroup?: string
    requestTimeoutMs: number
    subscriptions: Map<string, NatsSubscription>
    scope: Scope
  }

  export interface DispatchPayload {
    cid: string
    serviceName: string
    actionKey: string
    params?: unknown[]
    inputSubjects?: string[]
    outputSubject?: string
    contexts?: TransportDef.DispatchContexts
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

  export interface WireStream {
    _t: '__stream__'
  }

  export type Wire = WireSuccess | WireFailure | WireStream

  export interface StreamErrorPayload {
    error: string
    message: string
    causes?: string[]
  }
}
