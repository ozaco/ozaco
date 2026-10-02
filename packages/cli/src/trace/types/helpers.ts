import type { PaletteDef } from 'cli:palette'
import type { TraceDef } from 'std:trace'

/** The shapes this module passes around inside itself. */
export namespace Helpers {
  /** The glyphs a block is drawn with — the unicode or the ASCII set. */
  export interface Glyphs {
    /** In front of a one-span trace's single line. */
    single: string
    /** A span's share of the axis. */
    bar: string
    /** The axis where the span is not. */
    track: string
    /** A span event on the bar. */
    event: string
    /** An `exception` event on the bar. */
    exception: string
    /** A log record on the bar and in front of its line. */
    record: string
    /** The header rule. */
    rule: string
    /** `✗` in front of an outcome that is not `ok`. */
    failed: string
    /** The ends of the bar. */
    open: string
    close: string
    /** Tree prefixes: a child, the last child, the line past a child, the gap past the last. */
    branch: string
    last: string
    line: string
    gap: string
  }

  /** One drawn row of a trace block. */
  export interface Row {
    readonly span: TraceDef.SpanData
    /** The tree prefix (`├─ `, `│  └─ `, …), empty on a root. */
    readonly prefix: string
    /** The records emitted in this span, by time. */
    readonly logs: readonly TraceDef.LogData[]
  }

  /** The columns of a trace block, resolved against the block's spans. */
  export interface Layout {
    readonly palette: PaletteDef.Context
    readonly glyphs: Glyphs
    /** The width of the whole line. */
    readonly width: number
    /** The columns of the name column (tree prefix included). */
    readonly label: number
    /** The columns of the bar. */
    readonly bar: number
    /** The time the bars start at (epoch ms). */
    readonly origin: number
    /** The time the bars span (ms, never 0). */
    readonly extent: number
    /** The block's service — a row names its own only when it differs. */
    readonly service: string | null
  }
}
