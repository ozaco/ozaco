import type { Result } from 'std:result'

import type { LoggerDef } from './logger'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  export interface BuildEntrySource {
    ctx: LoggerDef.Context
    bindings: Record<string, unknown>
    /** The active span's ids (`null` outside of any). */
    trace?: LoggerDef.Trace | null | undefined
  }

  /** One payload walk: the failures found so far and the objects on the current path (cycles). */
  export interface PayloadWalk {
    readonly failures: Result.Failure<unknown>[]
    readonly path: WeakSet<object>
  }

  export interface NormalizedPayload {
    msg: string
    data: Record<string, unknown> | undefined
    error: string
    failures: Result.Failure<unknown>[]
  }
}
