import type { BoundLogger } from 'server:utils'
import type { Operation, Scope } from 'std:effect'
import type { EventEmitter } from 'std:event'
import type { Maybe } from 'std:result'

import type { Meta, Reply } from './common'
import type { Service, ActionKey, ArgsOf, ReturnsOf } from './service'
import type { Outcome, Trace, TraceOrigin } from './trace'

export interface BrokerOptions {
  /** Broker display name (defaults to `broker`). */
  readonly name?: string | undefined
  readonly ackTimeoutMs?: number | undefined
  readonly requestTimeoutMs?: number | undefined
  readonly outcomeTtlMs?: number | undefined
}

export interface CallOptions {
  readonly meta?: Meta | undefined
  /** Marks the call tree's origin when there is no ambient trace (edges pass `external`). */
  readonly origin?: TraceOrigin | undefined
  /** Adopt an existing trace instead of the ambient one (edges hand over the minted trace). */
  readonly trace?: Trace | undefined
  readonly timeoutMs?: number | undefined
  readonly ackTimeoutMs?: number | undefined
  /** Dedupe key — a retry after `TimeoutPending` with the same key cannot double-execute. */
  readonly idempotencyKey?: string | undefined
  /** Persist this call's outcome even when the reply is delivered normally. */
  readonly outcome?: boolean | undefined
  /** Non-value input planes keyed by `DataType` (handlers take them with `useSource`). */
  readonly sources?: ReadonlyMap<string, unknown> | undefined
}

/** Cold internals of the broker protocol (types-only namespace). */
export namespace BrokerDef {
  /** One registered service instance. */
  export interface ServiceEntry {
    readonly service: Service
    /** Instance-qualified id: `name@version#instance`. */
    readonly serviceId: string
  }

  /** TTL'd owner-side outcome records (see the fulfillment model). */
  export interface OutcomeStore {
    record(outcome: Outcome): void
    get(cid: string): Maybe<Outcome>
    size(): number
  }

  /** TTL'd reply dedupe keyed by `idempotencyKey` — the carrier-agnostic dedupe fallback. */
  export interface ReplyCache {
    get(key: string): Reply | undefined
    set(key: string, reply: Reply): void
  }
}

export interface BrokerContext {
  readonly name: string
  readonly nodeId: string
  readonly scope: Scope
  readonly log: BoundLogger
  readonly options: {
    readonly ackTimeoutMs: number
    readonly requestTimeoutMs: number
    readonly outcomeTtlMs: number
  }
  readonly registry: Map<string, BrokerDef.ServiceEntry>
  readonly bus: EventEmitter<Record<string, [unknown, Trace?]>>
  readonly outcomes: BrokerDef.OutcomeStore
  readonly replies: BrokerDef.ReplyCache
  readonly state: { started: boolean; paused: boolean; destroyed: boolean }
}

export interface BrokerActions {
  start(): Operation<void>
  isStarted(): Operation<boolean>
  pause(): Operation<void>
  resume(): Operation<void>
  isPaused(): Operation<boolean>
  destroy(): Operation<void>

  register(service: Service): Operation<void>
  unregister(service: Service | string): Operation<void>
  hosts(service: Service | string): Operation<boolean>
  getServices(): Operation<readonly string[]>

  /** Typed value call — unwraps the reply, re-raises failures with breadcrumbs appended. */
  call<S extends Service, K extends ActionKey<S>>(
    service: S,
    action: K,
    params: ArgsOf<S, K>,
    options?: CallOptions,
  ): Operation<ReturnsOf<S, K>>
  call(service: string, action: string, params?: unknown, options?: CallOptions): Operation<unknown>

  /** Full-fidelity call — returns the {@link Reply} (status/meta/failure/stream included). */
  exchange(
    service: Service | string,
    action: string,
    params?: unknown,
    options?: CallOptions,
  ): Operation<Reply>

  /** Deliver to the first interested carrier ("someone handles it"). */
  emit(name: string, payload?: unknown): Operation<void>
  /** Deliver to every carrier and every node. */
  broadcast(name: string, payload?: unknown): Operation<void>
  /** Local subscription; returns the unsubscribe function. */
  on(name: string, handler: (payload: unknown, trace?: Trace) => void): Operation<() => void>

  /** Owner-side truth for a dispatch after `TimeoutPending` — see the fulfillment model. */
  outcome(cid: string): Operation<Maybe<Outcome>>
}
