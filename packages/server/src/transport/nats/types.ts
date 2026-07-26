import type { Carried, TransportDef } from 'server:core'
import type { Scope } from 'std:effect'

import type { ConsumerMessages, JetStreamClient, JetStreamManager, NatsConnection } from 'nats'

export namespace Nats {
  export interface Options extends TransportDef.Options {
    servers?: string | string[]
    subjectPrefix?: string
    /** The group this node joins for QUEUED events — one member of each group sees each event.
     * Defaults to `'default'`, so unnamed nodes form one group rather than each its own. */
    queueGroup?: string
    /** How long a dispatch waits for its reply. Default 30000ms. Set `0` (or negative) to DISABLE the
     * transport timeout and let the action `TimeoutPolicy` be the sole authority. */
    requestTimeoutMs?: number
  }

  export interface Context extends TransportDef.Context {
    connection: NatsConnection
    js: JetStreamClient
    jsm: JetStreamManager
    prefix: string
    /** the queued-event group, RAW — `eventDurable` owns flattening it into a durable-safe name */
    group: string
    requestTimeoutMs: number
    /** every long-lived JetStream consumer this node runs, stopped at teardown */
    consumers: Map<string, ConsumerMessages>
    scope: Scope
  }

  /**
   * What one dispatch carries INSIDE the work-queue message.
   *
   * The call id and the reply inbox ride the HEADERS (`HDR_CID` / `HDR_REPLY`), not this payload:
   * every lane subject is derived from the cid in one place, so there is no list of subjects for
   * the two sides to disagree about. `lanes` is the manifest of what travels beside the payload —
   * how many plain lanes, and whether a multipart parts lane exists.
   */
  export interface DispatchPayload {
    serviceName: string
    actionKey: string
    /** mapped to a string on the wire and back to the symbol on arrival — a symbol cannot survive a codec */
    origin?: 'internal' | 'external'
    meta?: Record<string, string>
    /** what the call carries and what its answer will hold, so a return channel can exist first */
    wire?: { sends: Carried[]; receives: Carried[] }

    params?: unknown[]
    lanes?: { streams: number; parts: boolean }
    contexts?: TransportDef.DispatchContexts
  }

  export interface WireSuccess {
    _t: '__success__'
    value: unknown
    /** the reply half: what the action set with `useResponse()`, carried home rather than dropped */
    status?: number
    meta?: Record<string, string>
  }

  export interface WireFailure {
    _t: '__failure__'
    /** the fault, so a status the owner had already set survives the hop with its tag */
    halted?: string
    status?: number
    meta?: Record<string, string>
    error: string
    message: string
    causes?: string[]
  }

  export interface WireStream {
    _t: '__stream__'
    status?: number
    meta?: Record<string, string>
  }

  export type Wire = WireSuccess | WireFailure | WireStream

  export interface StreamErrorPayload {
    error: string
    message: string
    causes?: string[]
  }

  /** The payload of a `field` part message on a parts lane. */
  export interface PartField {
    name: string
    value: string
  }

  /** The payload of a `file` part-open message on a parts lane; raw chunks follow until file-end. */
  export interface PartFile {
    name: string
    filename?: string
    mediaType?: string
  }
}
