import type { Operation } from 'std:effect'
import type { TraceDef } from 'std:trace'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  /** What the scope-close fallback end needs: the span until it ends, and when the headers came. */
  export interface Fallback {
    span: TraceDef.LiveSpan | undefined
    at: number | undefined
  }

  /** A request span as the request hands it on, its fallback holder and the scope-close end. */
  export interface Released {
    span: TraceDef.LiveSpan
    fallback: Fallback
    end: () => Operation<void> | undefined
  }
}
