import type { PaletteDef } from 'cli:palette'

import type { Helpers } from '../types/helpers'
import type { TerminalTracerDef } from '../types/trace'

import { glyphsOf, layoutOf } from './layout'
import { headerLine, logLines, singleLine, spanLine } from './lines'
import { rowsOf } from './rows'

/**
 * One block for what a trace sent: the header, then a row per span in tree order — its bar on
 * one shared timeline from the earliest start to the latest end, its records under it — and the
 * records that belong to no span of the block last. A trace of ONE span is a single line.
 */
export const renderBlock = (
  pending: Pick<TerminalTracerDef.Pending, 'spans' | 'logs'>,
  options: { width: number; palette: PaletteDef.Context },
): string[] => {
  const rows = rowsOf(pending.spans, pending.logs, glyphsOf(options.palette))
  const layout: Helpers.Layout = layoutOf(rows, options)
  const shown = new Set(rows.flatMap(row => row.logs))
  // one span (a WS frame, a bare request) has no axis worth drawing: ONE line instead of a block
  const single = rows.length === 1 ? rows[0] : undefined
  const lines = single === undefined ? [headerLine(rows, layout)] : []

  for (const row of rows) {
    lines.push(single === undefined ? spanLine(row, layout) : singleLine(row, layout))

    for (const log of row.logs) {
      lines.push(...logLines(log, `${' '.repeat(row.prefix.length)}   `, layout))
    }
  }

  for (const log of pending.logs.filter(item => !shown.has(item))) {
    lines.push(...logLines(log, '   ', layout))
  }

  return lines
}
