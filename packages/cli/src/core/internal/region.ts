import { ansi } from '../const'
import { displayWidth } from '../utils'

/**
 * Pure live-region math. A region is the block of terminal rows the last frame occupied — computed
 * wrap-aware from the CURRENT column count so the erase codes remove exactly that block.
 */
export const rowsOf = (frame: string, columns: number): number => {
  if (frame === '') {
    return 0
  }

  let rows = 0
  for (const line of frame.split('\n')) {
    rows += Math.max(1, Math.ceil(displayWidth(line) / Math.max(1, columns)))
  }
  return rows
}

/** The codes that move to the region's first row and erase it (empty when nothing was drawn). */
export const eraseCodes = (rows: number): string =>
  rows === 0 ? '' : ansi.cursorToColumn(0) + ansi.cursorUp(rows - 1) + ansi.eraseDown
