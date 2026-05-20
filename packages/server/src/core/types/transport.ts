import type { Future } from 'std:effect'

import type { TracerDef } from './tracer'

export namespace TransportDef {
  export interface Options {
    name?: string
  }

  export interface Context {
    name: string
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
}
