import type { Operation } from 'std:effect'
import type { Plugin } from 'std:plugin'
import type { AnyType } from 'std:shared'

import type { TraceDef } from './trace'

/** The owner-side record of dispatches whose reply could not be delivered (or that opted in):
 * what a caller that hit `timeout-pending` reconciles against. */
export namespace OutcomesDef {
  export interface Options {
    readonly store: string
    readonly ttlMs: number
  }

  export interface Actions {
    describe(): Operation<Options>
    put(outcome: TraceDef.Outcome): Operation<void>
    get(cid: string): Operation<TraceDef.Outcome | null>

    /** Drop records older than the TTL; resolves how many went. */
    prune(): Operation<number>
  }

  export type Defaults = Pick<Actions, 'describe'>

  export type Handle = Plugin<Options, AnyType[], Actions>
}
