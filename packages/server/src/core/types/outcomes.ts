import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

/** A built outcome-store plugin (`MemoryOutcomes`, `DbOutcomes`) — install options are the
 * impl's own, so the argument list stays open. */
export type OutcomesDef = Plugin<OutcomesDef.Context, AnyType[], OutcomesDef.Actions>

/** The owner-side record of dispatches whose reply could not be delivered (or that opted in):
 * what a caller that hit `timeout-pending` reconciles against. */
export namespace OutcomesDef {
  export type OutcomeState = 'fulfilled' | 'failed' | 'cancelled'

  /** The owner-side truth about a dispatch whose reply could not be delivered normally. */
  export interface Outcome {
    /** the dispatch's carrier correlation id (`WireDef.Dispatch.cid`). */
    readonly cid: string
    readonly state: OutcomeState
    readonly service_id: string
    readonly action_id: string
    readonly error: string | null
    readonly ts: number
  }

  export interface Options {
    readonly store: string
    readonly ttlMs: number
  }

  /** What the install resolves is exactly {@link Options} here. */
  export type Context = Options

  export interface Actions {
    put(outcome: Outcome): Operation<void>
    get(cid: string): Operation<Outcome | null>

    /** Drop records older than the TTL; resolves how many went. */
    prune(): Operation<number>
  }
}
