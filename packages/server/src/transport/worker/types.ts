import type { TransportDef } from 'server:core'
import type { Queue, Scope, Stream, Task } from 'std:effect'
import type { Result } from 'std:result'

export namespace WorkerDef {
  export type WireMode = 'structured' | 'codec'

  export interface PortLike {
    postMessage(message: unknown, transfer?: unknown[]): void
    addEventListener?: (type: 'message', listener: (event: { data: unknown }) => void) => void
    on?: (event: 'message', listener: (data: unknown) => void) => void
    start?: () => void
    terminate?: () => void
    close?: () => void
  }

  export interface Options extends TransportDef.Options {
    script?: string | URL
    count?: number
    endpoint?: PortLike | PortLike[]
    wire?: WireMode
  }

  export interface Endpoint {
    wire: WireMode
    post(message: Envelope): void
    recv: Stream<unknown, void>
    markReady(): void
    close(): void
  }

  export interface Context extends TransportDef.Context {
    wire: WireMode
    adoptWire: boolean
    endpoints: Endpoint[]
    pending: Map<string, (wire: Wire) => void>
    streams: Map<string, Queue<unknown, true | Result.Failure<unknown>>>
    handlers: Map<string, Task<unknown, unknown>>
    scope: Scope
    rr: { index: number }
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

  export interface DispatchEnvelope {
    kind: 'dispatch'
    cid: string
    serviceName: string
    actionKey: string
    outputStream: string
    params?: unknown
    inputStreams?: string[]
    rawReq?: unknown
    traceContext?: unknown
  }

  export type Envelope =
    | DispatchEnvelope
    | { kind: 'ready'; wire: WireMode }
    | { kind: 'reply'; cid: string; wire: Wire }
    | { kind: 'cancel'; cid: string }
    | { kind: 'emit'; req: unknown }
    | { kind: 'broadcast'; req: unknown }
    | { kind: 'chunk'; sid: string; data: unknown }
    | { kind: 'end'; sid: string }
    | { kind: 'error'; sid: string; failure: StreamErrorPayload }
}
