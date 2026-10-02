import type { PaletteDef } from 'cli:palette'

import type { Helpers } from '../types/helpers'

import {
  ASCII_GLYPHS,
  FIXED_COLUMNS,
  LABEL_SHARE,
  MIN_BAR,
  MIN_LABEL,
  UNICODE_GLYPHS,
} from './const'
import { labelOf } from './format'

export const glyphsOf = (palette: PaletteDef.Context): Helpers.Glyphs =>
  palette.unicode ? UNICODE_GLYPHS : ASCII_GLYPHS

/** The columns of a block: the label column takes what the longest label needs, up to
 * {@link LABEL_SHARE} of the line, the bar the rest (never under {@link MIN_BAR}); the time axis
 * runs from the earliest start to the latest end of the SPANS; the block's service is the first
 * span's (tree order) that names one — a row names its own only when it differs. */
export const layoutOf = (
  rows: readonly Helpers.Row[],
  options: { width: number; palette: PaletteDef.Context },
): Helpers.Layout => {
  // the block's service: the first span (tree order) that names one — an edge root has none
  const service = rows.find(row => row.span.service !== null)?.span.service ?? null
  const longest = Math.max(0, ...rows.map(row => `${row.prefix}${labelOf(row, service)}`.length))
  const label = Math.max(MIN_LABEL, Math.min(longest, Math.floor(options.width * LABEL_SHARE)))
  const bar = Math.max(MIN_BAR, options.width - FIXED_COLUMNS - label)
  // the axis is the SPANS' — a record or event stamped with its own time (a client's clock, a
  // report arriving later) would stretch it until every bar collapsed; such a marker is drawn at
  // the edge it falls past
  const times = rows.flatMap(row => [row.span.start, row.span.end])
  const origin = Math.min(...times)

  return {
    palette: options.palette,
    glyphs: glyphsOf(options.palette),
    width: options.width,
    label,
    bar,
    origin,
    extent: Math.max(Math.max(...times) - origin, 0.001),
    service,
  }
}
