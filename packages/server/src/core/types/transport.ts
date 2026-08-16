import type { Operation } from 'std:effect'
import type { Maybe } from 'std:result'

import type { ActionSignal, Reply, Request } from './common'
import type { Trace } from './trace'

/** Install-time options every carrier shares (carrier-specific options extend these). */
export interface TransportOptions {
  readonly name?: string | undefined
  /** Routing order among carriers (lower runs first). */
  readonly priority?: number | undefined
}

/** A dispatch handed to a carrier, with the fulfillment signal it must fire on handler start. */
export interface TransportDispatch {
  readonly request: Request
  /** Fire exactly once when the owner acknowledged (handler started) — splits the timeouts. */
  readonly acked: () => void
  /** Caller-abandonment signal for local carriers (remote carriers use `cancel` envelopes). */
  readonly signal?: ActionSignal | undefined
  /** Non-value input planes keyed by `DataType` (local pass-through; remote carriers use lanes). */
  readonly sources?: ReadonlyMap<string, unknown> | undefined
}

/** An emit/broadcast crossing carriers. */
export interface TransportEvent {
  readonly name: string
  readonly payload: unknown
  readonly trace: Trace
  readonly scope: 'emit' | 'broadcast'
  /** Emitting node id — receivers drop their own echoes. */
  readonly origin: string
}

/** The per-carrier action surface (each impl registers itself into the routing table). */
export interface TransportActions {
  /** `just(true)` hosts, `just(false)` does not, `nothing()` unknown (fallback candidate). */
  hosts(service: string): Operation<Maybe<boolean>>
  dispatch(dispatch: TransportDispatch): Operation<Reply>
  emit(event: TransportEvent): Operation<'handled' | 'skipped'>
  broadcast(event: TransportEvent): Operation<void>
}

/** Cold routing-table internals of the transport protocol (types-only namespace). */
export namespace TransportDef {
  /** One registered carrier in the routing table. */
  export interface Entry {
    readonly name: string
    readonly priority: number
    readonly actions: TransportActions
  }

  /** Protocol-level routing handlers (implemented once by the core routers). */
  export interface Handlers {
    dispatchRoot(dispatch: TransportDispatch): Operation<Reply>
    emitRoot(event: TransportEvent): Operation<void>
    broadcastRoot(event: TransportEvent): Operation<void>
    register(entry: Entry): Operation<void>
    unregister(name: string): Operation<void>
    getTransports(): Operation<readonly Entry[]>
  }
}
