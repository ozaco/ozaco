import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'

import type { TracerDef } from './tracer'

export type TransportDef = Plugin<TransportDef.Context, unknown, unknown[], TransportDef.Actions>

export namespace TransportDef {
  export interface Options {
    name?: string
    priority?: number
    next?: boolean
  }

  export interface Context {
    name: string
    priority: number
    next: boolean
  }

  export interface DispatchRequest {
    serviceName: string
    actionKey: string
    params?: unknown[]
    rawReq?: unknown
    traceContext?: TracerDef.SpanContext
  }

  export interface EventRequest {
    name: string
    payload: unknown
    groups?: ReadonlyArray<string>
    traceContext?: TracerDef.SpanContext
  }

  export interface Actions {
    dispatch(req: DispatchRequest): Future<unknown, unknown>
    emit(req: EventRequest): Future<void, unknown>
    broadcast(req: EventRequest): Future<void, unknown>
  }

  export interface Handlers {
    dispatchRoot(req: DispatchRequest): Future<unknown, unknown>
    emitRoot(req: EventRequest): Future<void, unknown>
    broadcastRoot(req: EventRequest): Future<void, unknown>
  }
}
