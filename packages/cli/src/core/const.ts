import { createTags } from 'std:shared'

// ESC (U+001B) control byte; CSI = Control Sequence Introducer (ESC + '[').
const ESC = String.fromCodePoint(27)
const CSI = `${ESC}[`

export const TERMINAL = Symbol.for('cli:core:terminal')
export const SPINNER = Symbol.for('cli:core:spinner')
export const PALETTE = Symbol.for('cli:core:palette')
export const PROMPT = Symbol.for('cli:core:prompt')
export const REGISTRY = Symbol.for('cli:core:registry')
export const TABLE = Symbol.for('cli:core:table')

export const DEFAULT_COLUMNS = 80
export const DEFAULT_ROWS = 24

export const CoreErrors = createTags(
  'cli:core',

  'unsupported',
  'cancelled',
  'not-interactive',
  'missing',
)

export const ansi = {
  esc: ESC,
  csi: CSI,

  cursorUp: (count = 1): string => (count > 0 ? `${CSI}${count}A` : ''),
  cursorDown: (count = 1): string => (count > 0 ? `${CSI}${count}B` : ''),
  cursorForward: (count = 1): string => (count > 0 ? `${CSI}${count}C` : ''),
  cursorBackward: (count = 1): string => (count > 0 ? `${CSI}${count}D` : ''),

  /** Move to an absolute column (0-based). */
  cursorToColumn: (column = 0): string => `${CSI}${column + 1}G`,

  /** Erase the entire current line. */
  eraseLine: `${CSI}2K`,
  /** Erase from the cursor to the end of the screen. */
  eraseDown: `${CSI}J`,

  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
} as const
