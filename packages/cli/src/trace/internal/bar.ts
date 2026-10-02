import type { Helpers } from '../types/helpers'

import { EXCEPTION_EVENT } from './const'
import { barStyle } from './format'

/** The bar of one span: its share of the timeline filled, every event (an `exception` with its
 * own glyph) and record a marker at its time — a marker outside the bar (a record after the span
 * ended) is drawn where it falls on the track. */
export const barOf = (row: Helpers.Row, layout: Helpers.Layout): string => {
  const { glyphs, palette } = layout
  const cells = Array.from({ length: layout.bar }, () => glyphs.track)
  const cell = (time: number) => ((time - layout.origin) / layout.extent) * layout.bar
  const at = (time: number) => Math.min(layout.bar - 1, Math.max(0, Math.floor(cell(time))))
  const from = at(row.span.start)
  const to = Math.max(from + 1, Math.min(layout.bar, Math.ceil(cell(row.span.end))))

  cells.fill(glyphs.bar, from, to)

  for (const log of row.logs) {
    cells[at(log.time)] = glyphs.record
  }

  for (const event of row.span.events) {
    cells[at(event.time)] = event.name === EXCEPTION_EVENT ? glyphs.exception : glyphs.event
  }

  const style = barStyle(row.span, palette.colors)

  // paint runs, not cells: the track dim, everything on the bar in the span's style
  return cells
    .join('')
    .split(new RegExp(`(${glyphs.track === '.' ? String.raw`\.` : glyphs.track}+)`, 'u'))
    .filter(run => run !== '')
    .map(run => (run.startsWith(glyphs.track) ? palette.colors.dim(run) : style(run)))
    .join('')
}
