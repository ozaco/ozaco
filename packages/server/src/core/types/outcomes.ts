import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { TraceDef } from './trace'

/** A built outcome-store plugin (`MemoryOutcomes`, `DbOutcomes`) — install options are the
 * impl's own, so the argument list stays open. */
export type OutcomesDef = Plugin<OutcomesDef.Context, AnyType[], OutcomesDef.Actions>

/** The owner-side record of dispatches whose reply could not be delivered (or that opted in):
 * what a caller that hit `timeout-pending` reconciles against. */
export namespace OutcomesDef {
  export interface Options {
    readonly store: string
    readonly ttlMs: number
  }

  /** What the install resolves is exactly {@link Options} here. */
  export type Context = Options

  export interface Actions {
    put(outcome: TraceDef.Outcome): Operation<void>
    get(cid: string): Operation<TraceDef.Outcome | null>

    /** Drop records older than the TTL; resolves how many went. */
    prune(): Operation<number>
  }
}
