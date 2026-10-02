import type { PaletteDef } from 'cli:palette'
import type { TraceDef } from 'std:trace'

import type { Helpers } from '../types/helpers'

/** Flush a trace with more spans waiting than this, whatever its root did. */
export const MAX_PENDING = 1024

/** The width drawn when the terminal reports none (a pipe, a task runner). */
export const DEFAULT_WIDTH = 120

/** The narrowest bar drawn; the label column gives way before it. */
export const MIN_BAR = 12

/** The narrowest label column. */
export const MIN_LABEL = 8

/** The widest label column, as a share of the line. */
export const LABEL_SHARE = 0.45

/** The width of the kind column (`INTERNAL`). */
export const KIND_COLUMNS = 8

/** The width of the duration column (`   12.40ms`). */
export const DURATION_COLUMNS = 9

/** The columns beside the label and the bar: ` KIND     ▕` + `▏ ` + `   12.40ms` + ` `. */
export const FIXED_COLUMNS = 1 + KIND_COLUMNS + 2 + 2 + DURATION_COLUMNS + 1

/** The span event std:trace records a failure as. */
export const EXCEPTION_EVENT = 'exception'

/** The attribute that marks an exception record. */
export const EXCEPTION_TYPE = 'exception.type'

/** The attributes an event record's line leaves out: its name is already shown. */
export const EVENT_KEYS: ReadonlySet<string> = new Set(['otel.event.name'])

export const SEVERITIES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const

export const UNICODE_GLYPHS: Helpers.Glyphs = {
  single: '▪',
  bar: '█',
  track: '·',
  event: '◆',
  exception: '✖',
  record: '◇',
  rule: '━',
  failed: '✗',
  open: '▕',
  close: '▏',
  branch: '├─ ',
  last: '└─ ',
  line: '│  ',
  gap: '   ',
}

export const ASCII_GLYPHS: Helpers.Glyphs = {
  single: '-',
  bar: '#',
  track: '.',
  event: '*',
  exception: 'X',
  record: 'o',
  rule: '=',
  failed: 'x',
  open: '[',
  close: ']',
  branch: '|- ',
  last: '`- ',
  line: '|  ',
  gap: '   ',
}

/** The palette colour a span kind's bar takes. */
export const KIND_COLOR: Readonly<Record<TraceDef.SpanKind, keyof PaletteDef.Colors>> = {
  server: 'success',
  client: 'primary',
  internal: 'info',
  producer: 'accent',
  consumer: 'accent',
}
