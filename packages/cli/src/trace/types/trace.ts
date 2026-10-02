import type { PaletteDef } from 'cli:palette'
import type { Scope } from 'std:effect'
import type { TraceDef } from 'std:trace'

export namespace TerminalTracerDef {
  export interface Options {
    /** The width of a drawn line in columns; default: the terminal's size at each draw. */
    width?: number | undefined
    /**
     * A trace whose root span (no parent) has not ended — a span answering a remote caller, an
     * orphan under an explicit `parent`, a long stream whose children end first — is drawn once no
     * span or record of it arrived for this long (ms); default 1000. The spans that arrive later
     * are drawn in a further block of the same trace.
     */
    idleMs?: number | undefined
  }

  export interface Context {
    readonly width: number | undefined
    readonly idleMs: number
    readonly palette: PaletteDef.Context
    /** The scope an idle draw runs in (a timer fires outside every scope). */
    readonly scope: Scope
    /** The traces collected so far, by trace id. */
    readonly pending: Map<string, Pending>
    readonly options: Options
  }

  /** What a trace has sent since its last block was drawn. */
  export interface Pending {
    readonly spans: TraceDef.SpanData[]
    readonly logs: TraceDef.LogData[]
    timer: ReturnType<typeof setTimeout> | undefined
  }
}
