import type { Future, Stream } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Result } from 'std:result'

import type { TracerDef } from './tracer'

export type TransportDef = Plugin<TransportDef.Context, unknown[], TransportDef.Actions>

export namespace TransportDef {
  export interface Options {
    name?: string
    priority?: number
    next?: (failure: Result.Failure<unknown>) => boolean
  }

  export interface Context {
    name: string
    priority: number
    next: (failure: Result.Failure<unknown>) => boolean
  }

  /** Serializable subset of the gateway `ActionRequest`, carried across transports so a remote action
   * can rebuild its `ActionRequestContext` (e.g. for auth headers / per-principal policy keys). The
   * non-serializable parts of `ActionRequest` (file streams, the URL object) are reconstructed on the
   * far side — `url` travels as a string, `files` come back empty. */
  export interface RequestEnvelope {
    type: string
    method: string
    url: string
    meta: Record<string, string>
  }

  /** Per-call context propagated alongside a dispatch so a remote action can rebuild its environment.
   * Grouped under one key so new context kinds can be added without widening DispatchRequest. */
  export interface DispatchContexts {
    /** Raw platform request (feeds CallContext.raw.req). */
    raw?: unknown
    /** Serializable ActionRequest — rebuilds ActionRequestContext (auth headers, per-principal keys). */
    request?: RequestEnvelope
    /** Tracing span context. */
    trace?: TracerDef.SpanContext
  }

  export interface DispatchRequest {
    serviceName: string
    actionKey: string
    params?: unknown[]
    streams?: Stream<unknown, void>[]
    contexts?: DispatchContexts
  }

  export interface EventRequest {
    name: string
    payload: unknown
    groups?: ReadonlyArray<string>
    traceContext?: TracerDef.SpanContext
  }

  export interface Actions {
    dispatch(req: DispatchRequest): Future<unknown>
    emit(req: EventRequest): Future<void>
    broadcast(req: EventRequest): Future<void>
  }

  export interface Handlers {
    dispatchRoot(req: DispatchRequest): Future<unknown>
    emitRoot(req: EventRequest): Future<void>
    broadcastRoot(req: EventRequest): Future<void>

    register(transport: TransportDef, entryCtx: TransportDef.Context): Future<void>
    unregister(transport: TransportDef): Future<void>
    getTransports(): Future<TransportDef[]>
  }
}
