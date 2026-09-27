import type { Context } from 'std:effect'
import { createContext, markContextAsSnapshot } from 'std:effect'
import type { TraceDef } from 'std:trace'

import type { ServerDef } from './types/server'

/**
 * The request the running operation belongs to — `RequestRef`'s value. A FROZEN class instance:
 * the snapshot context hands every fork the same object (snapshots never copy class instances),
 * and nobody can rewrite it underneath them.
 */
export class ActiveRequest implements ServerDef.ActiveRequest {
  readonly requestId: string
  readonly origin: ServerDef.Origin

  constructor(requestId: string, origin: ServerDef.Origin) {
    this.requestId = requestId
    this.origin = origin
    Object.freeze(this)
  }
}

/**
 * The request the running operation belongs to (set by the edge per request, by the dispatch
 * path per dispatch, by `server.call` from outside any dispatch). Spans and trace ids live in
 * `std:trace` (`ActiveSpan`); this carries only what a span does not: the request id and where
 * the request entered. A snapshot context — forks keep the value they were created under.
 */
export const RequestRef: Context<ActiveRequest> = markContextAsSnapshot(
  createContext<ActiveRequest>('server:request'),
)

/** The handler context of the dispatch currently running. */
export const CtxRef = createContext<ServerDef.Ctx>('server:ctx')

/**
 * The handle of the dispatch span `{service}.{action}` running here — set by the dispatch span
 * for its whole extent (every plugin `dispatch` hook, the handler), so a plugin writes
 * dispatch-level attributes / links / events on THAT span even while a span of its own (a cache
 * span wrapping the dispatch) is the active one. Server-internal: read it through
 * `dispatchSpan()` (`@ozaco/server/internal`). A snapshot context — forks keep the dispatch they
 * were created under.
 */
export const DispatchSpan: Context<TraceDef.SpanHandle> = markContextAsSnapshot(
  createContext<TraceDef.SpanHandle>('server:dispatch-span'),
)
