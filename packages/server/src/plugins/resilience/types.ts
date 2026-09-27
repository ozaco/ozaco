import type { OptionsDef, ServerDef } from 'server:core'
import type { Operation, Utils } from 'std:effect'
import type { Result } from 'std:result'
import type { TraceDef } from 'std:trace'

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

    /** The DISPATCH span (`dispatchSpan()`) — even while an outer plugin's span (a cache span
     * wrapping the chain) is the active one: its attributes, links and events describe what the
     * layers decided. */
    readonly span: TraceDef.SpanHandle
    readonly next: Next
  }

  /** A circuit's state as its `ozaco.breaker` events name it. */
  export type CircuitState = 'closed' | 'open' | 'half_open'

  export interface BreakerState {
    /** consecutive counted (`statusOf >= 500`) failures. */
    failures: number
    openedAt: number | null

    /** a half-open trial call is in flight. */
    trial: boolean

    /** the span of the call that tripped the circuit open — rejections link it. */
    trippedBy: TraceDef.SpanContext | null
  }

  export interface BulkheadState {
    readonly semaphore: Utils.Semaphore

    /** calls waiting for a slot (counted before they park: the queue bound holds across yields). */
    queued: number
  }

  /** A singleflight leader's computation: its outcome (`null` ⇒ the leader was halted — its
   * followers go round again) and its span (followers link it). */
  export interface Flight {
    readonly outcome: Operation<Result<unknown> | null>
    readonly leader: TraceDef.SpanContext | null
  }

  export interface State {
    readonly breakers: Map<string, BreakerState>
    readonly bulkheads: Map<string, BulkheadState>
    readonly inflight: Map<string, Flight>
    readonly counters: Map<string, { count: number; window: number }>
  }
}
