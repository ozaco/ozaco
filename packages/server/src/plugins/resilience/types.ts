import type { OptionsDef, ServerDef } from 'server:core'
import type { Operation } from 'std:effect'
import type { Result } from 'std:result'

export namespace ResilienceDef {
  /** The option shapes live in core, next to the action config that carries them. */
  export type Retry = OptionsDef.Retry
  export type Breaker = OptionsDef.Breaker
  export type Bulkhead = OptionsDef.Bulkhead
  export type RateLimit = OptionsDef.RateLimit
  export type Fallback = OptionsDef.Fallback

  /** The action options this plugin owns (all optional, all top-level on the action config). */
  export type Options = Pick<
    OptionsDef.ActionOptions,
    'timeoutMs' | 'retry' | 'breaker' | 'bulkhead' | 'singleflight' | 'rateLimit' | 'fallback'
  >

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
