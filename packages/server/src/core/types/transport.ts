import type { Future } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { Maybe, Result } from 'std:result'

import type { Request, Response } from './common'
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
    /** Serializable ActionRequest — rebuilds ActionRequestContext (auth headers, per-principal keys). */
    request?: RequestEnvelope
    /** Tracing span context. */
    trace?: TracerDef.SpanContext
  }

  /**
   * What a carrier conveys: the portable {@link Request}, plus the process-local extras.
   *
   * Extending rather than restating it is the point. The envelope used to be a shape of its own —
   * `serviceName`/`actionKey`/`params`/`streams` — which meant `origin` had nowhere to travel and
   * `meta` was smuggled inside `contexts.request`, so a call's own metadata and a rebuilt auth
   * envelope were the same field wearing two hats. `contexts` is what genuinely does NOT cross a
   * process boundary intact: a raw platform request, and a trace parent.
   */
  export interface DispatchRequest extends Request {
    contexts?: DispatchContexts
  }

  export interface EventRequest {
    name: string
    payload: unknown
    groups?: ReadonlyArray<string>
    traceContext?: TracerDef.SpanContext
  }

  export interface Actions {
    /**
     * Does this carrier serve that address — asked BEFORE anything runs.
     *
     * This replaces the `next` predicate, and that is the whole change. `next` was consulted AFTER
     * a dispatch had already failed, so the router had to RUN something to find out whether it
     * should have — and because the predicate keyed on `not-found`, an action's own 404 looked
     * exactly like "not hosted here" and the body ran again on the next carrier, side effects
     * included. Asking first makes placement a question with an answer instead of a failure to
     * interpret.
     *
     * `nothing()` is the honest answer from a carrier with no discovery, and also the one to
     * watch: it is the loophole through which at-most-once quietly becomes at-least-once.
     */
    hosts(service: string, path: string): Future<Maybe<boolean>>

    dispatch(req: DispatchRequest): Future<Response>
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
