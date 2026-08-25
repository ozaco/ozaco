// ESC (U+001B) control byte; CSI = Control Sequence Introducer (ESC + '[').
const ESC = String.fromCodePoint(27)
const CSI = `${ESC}[`

export const DEFAULT_COLUMNS = 80
export const DEFAULT_ROWS = 24

/**
 * The ANSI control sequences the package emits. Only the render lease and the terminal impls write
 * these — feature modules (prompt/spinner/table) never emit cursor codes directly.
 */
export const ansi = {
  esc: ESC,

  cursorUp: (count = 1): string => (count > 0 ? `${CSI}${count}A` : ''),

  /** Move to an absolute column (0-based). */
  cursorToColumn: (column = 0): string => `${CSI}${column + 1}G`,

  /** Erase from the cursor to the end of the screen. */
  eraseDown: `${CSI}J`,

  hideCursor: `${CSI}?25l`,
  showCursor: `${CSI}?25h`,
} as const
