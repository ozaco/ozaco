import type { LoggerDef } from './logger'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  export interface BuildEntrySource {
    ctx: LoggerDef.Context
    bindings: Record<string, unknown>
  }

  export interface NormalizedPayload {
    msg: string
    data: Record<string, unknown> | undefined
    error: string
  }
}
