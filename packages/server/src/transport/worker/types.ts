import type { Carried, TransportDef } from 'server:core'
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

  export type SpawnSpec = string | URL | { script: string | URL; count?: number }

  export interface Options extends TransportDef.Options {
    script?: SpawnSpec | SpawnSpec[]
    count?: number
    endpoint?: PortLike | PortLike[]
    wire?: WireMode
  }

  export interface Endpoint {
    wire: WireMode
    services: Set<string>
    post(message: Envelope): boolean
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
    handlers: Map<string, Task<unknown>>
    scope: Scope
    rr: Map<string, number>
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
    error: string
    errorValue?: unknown
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
    errorValue?: unknown
    message: string
    causes?: string[]
  }

  export interface DispatchEnvelope {
    kind: 'dispatch'
    cid: string
    serviceName: string
    actionKey: string
    /** mapped to a string on the wire and back to the symbol on arrival — a symbol cannot survive a codec */
    origin?: 'internal' | 'external'
    meta?: Record<string, string>
    /** what the call carries and what its answer will hold, so a return channel can exist first */
    wire?: { sends: Carried[]; receives: Carried[] }
    outputStream: string
    params?: unknown
    inputStreams?: string[]
    /** The dispatch contexts, codec-encoded as one blob (decoded back to DispatchContexts on receipt). */
    contexts?: unknown
  }

  export type Envelope =
    | DispatchEnvelope
    | { kind: 'ready'; wire: WireMode; services?: string[] }
    | { kind: 'reply'; cid: string; wire: Wire }
    | { kind: 'cancel'; cid: string }
    | { kind: 'emit'; req: unknown }
    | { kind: 'broadcast'; req: unknown }
    | { kind: 'chunk'; sid: string; data: unknown }
    | { kind: 'end'; sid: string }
    | { kind: 'error'; sid: string; failure: StreamErrorPayload }
}
