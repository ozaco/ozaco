import type { ServerDef } from 'server:core'
import type { Operation } from 'std:effect'
import type { Result } from 'std:result'

export namespace ResilienceDef {
  export interface Retry {
    /** how many times to retry after the first failure. */
    readonly times: number

    /** which failure tags retry. Default: `server.timeout-unreached`, `server.unavailable`. */
    readonly when?: readonly string[] | undefined

    /** first backoff delay; doubles each retry. Default 100. */
    readonly delayMs?: number | undefined
  }

  export interface Breaker {
    /** consecutive failures that open the circuit. */
    readonly failures: number

    /** how long the circuit stays open before one trial call. Default 10 000. */
    readonly halfOpenMs?: number | undefined
  }

  export interface Bulkhead {
    /** concurrent calls allowed. */
    readonly max: number

    /** calls that may wait for a slot. Default 0. */
    readonly queue?: number | undefined
  }

  export interface RateLimit {
    /** calls per window. */
    readonly limit: number
    readonly windowMs: number

    /** what the limit is keyed on. Default `'global'`. */
    readonly key?: 'global' | 'ip' | 'auth' | undefined
  }

  export type Fallback = (
    failure: Result.Failure<unknown>,
    call: ServerDef.Call,
    ctx: ServerDef.Ctx,
  ) => Operation<unknown>

  /** The action options this plugin owns (all optional, all top-level on the action config). */
  export interface Options {
    readonly timeoutMs?: number | undefined
    readonly retry?: Retry | undefined
    readonly breaker?: Breaker | undefined
    readonly bulkhead?: Bulkhead | undefined

    /** coalesce identical in-flight calls (same action, same input) into one. */
    readonly singleflight?: boolean | undefined
    readonly rateLimit?: RateLimit | undefined
    readonly fallback?: Fallback | undefined
  }

  export type Next = () => Operation<unknown>

  /** One layer's view of the dispatch it wraps. */
  export interface Step {
    readonly state: State
    readonly call: ServerDef.Call
    readonly ctx: ServerDef.Ctx
    readonly next: Next
  }

  export interface BreakerState {
    failures: number
    openedAt: number | null
    trial: boolean
  }

  export interface BulkheadState {
    active: number
    waiting: number
  }

  export interface State {
    readonly breakers: Map<string, BreakerState>
    readonly bulkheads: Map<string, BulkheadState>
    readonly inflight: Map<string, Operation<Result<unknown>>>
    readonly counters: Map<string, { count: number; window: number }>
  }
}
