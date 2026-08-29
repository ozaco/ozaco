import { displayWidth, stripAnsi } from 'cli:core'
import type { PaletteDef } from 'cli:palette'

import type { Helpers } from '../types/helpers'
import type { TableDef } from '../types/table'

const MIN_WIDTH = 1

/**
 * Shorten to `max` VISIBLE cells. Widths are always measured ANSI-stripped (core `displayWidth`) —
 * that is the styled-cell alignment fix. A styled cell that must actually be cut is stripped first
 * (a truncated escape sequence would corrupt the terminal), trading its style for correctness.
 */
const truncate = (text: string, max: number, ellipsis: string): string => {
  if (max <= 0) {
    return ''
  }
  if (displayWidth(text) <= max) {
    return text
  }
  const chars = Array.from(stripAnsi(text))
  const dots = Array.from(ellipsis).length
  if (max <= dots) {
    return chars.slice(0, max).join('')
  }
  return `${chars.slice(0, max - dots).join('')}${ellipsis}`
}

const pad = (text: string, width: number, align: TableDef.Align): string => {
  const gap = width - displayWidth(text)
  if (gap <= 0) {
    return text
  }
  if (align === 'right') {
    return `${' '.repeat(gap)}${text}`
  }
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return `${' '.repeat(left)}${text}${' '.repeat(gap - left)}`
  }
  return `${text}${' '.repeat(gap)}`
}

const boxChars = (unicode: boolean): Helpers.BoxChars =>
  unicode
    ? {
        h: '─',
        v: '│',
        tl: '┌',
        tm: '┬',
        tr: '┐',
        ml: '├',
        mm: '┼',
        mr: '┤',
        bl: '└',
        bm: '┴',
        br: '┘',
      }
    : {
        h: '-',
        v: '|',
        tl: '+',
        tm: '+',
        tr: '+',
        ml: '+',
        mm: '+',
        mr: '+',
        bl: '+',
        bm: '+',
        br: '+',
      }

const headerLabel = (column: TableDef.Column): string =>
  column.header ?? (column.key === undefined ? '' : String(column.key))

const cellText = (column: TableDef.Column, row: TableDef.Row, index: number): string => {
  const value = Array.isArray(row)
    ? (row as readonly TableDef.Cell[])[index]
    : (row as Record<string, TableDef.Cell>)[String(column.key ?? headerLabel(column))]

  if (column.format) {
    return column.format(value)
  }
  return value === null || value === undefined ? '' : String(value)
}

/** Fixed horizontal chrome (borders/gutters) a table line spends beyond its cell content. */
const chromeWidth = (border: TableDef.Border, count: number, gutter: number): number =>
  border === 'full' ? 3 * count + 1 : gutter * Math.max(0, count - 1)

/** Shrink the widest columns until the row fits `budget`, never below `MIN_WIDTH`. */
const shrinkToFit = (widths: number[], budget: number): void => {
  let total = widths.reduce((sum, w) => sum + w, 0)
  let guard = total

  while (total > budget && guard > 0) {
    guard -= 1

    let index = -1
    let max = MIN_WIDTH
    for (const [i, w] of widths.entries()) {
      if (w > max) {
        max = w
        index = i
      }
    }

    const current = widths[index]
    if (current === undefined) {
      break
    }
    widths[index] = current - 1
    total -= 1
  }
}

const styledCells = (
  layout: Helpers.Layout,
  cells: string[],
  styles: (PaletteDef.Style | undefined)[],
): string[] =>
  cells.map((text, index) => {
    const width = layout.widths[index]!
    const shown = pad(truncate(text, width, layout.ellipsis), width, layout.aligns[index] ?? 'left')
    const style = styles[index]
    return style ? style(shown) : shown
  })

const joinCells = (layout: Helpers.Layout, parts: string[]): string => {
  if (layout.border === 'full') {
    const v = layout.muted(layout.chars.v)
    return `${v} ${parts.join(` ${v} `)} ${v}`
  }
  return parts.join(' '.repeat(layout.gutter))
}

const fullRule = (layout: Helpers.Layout, ends: [string, string, string]): string => {
  const [left, mid, right] = ends
  const segments = layout.widths.map(width => layout.chars.h.repeat(width + 2))
  return layout.muted(`${left}${segments.join(mid)}${right}`)
}

export const normalize = (options: TableDef.Options): Helpers.Normalized => ({
  columns: options.columns,
  border: options.border ?? 'full',
  gutter: options.gutter ?? 2,
  head: options.head ?? true,
  window: options.window,
})

export const makeLayout = (spec: {
  options: Helpers.Normalized
  rows: readonly TableDef.Row[]
  palette: PaletteDef.Context
  termColumns: number
}): Helpers.Layout => {
  const { options, rows, palette, termColumns } = spec
  const { columns } = options
  const headers = columns.map(headerLabel)

  const widths = columns.map((column, index) => {
    if (column.width !== undefined) {
      return Math.max(MIN_WIDTH, column.width)
    }

    let width = options.head ? displayWidth(headers[index]!) : 0
    for (const row of rows) {
      width = Math.max(width, displayWidth(cellText(column, row, index)))
    }
    if (column.min !== undefined) {
      width = Math.max(width, column.min)
    }
    if (column.max !== undefined) {
      width = Math.min(width, column.max)
    }
    return Math.max(MIN_WIDTH, width)
  })

  const budget = termColumns - chromeWidth(options.border, columns.length, options.gutter)
  shrinkToFit(widths, Math.max(columns.length * MIN_WIDTH, budget))

  return {
    columns,
    headers,
    widths,
    aligns: columns.map(column => column.align ?? 'left'),
    colors: columns.map(column => column.color),
    border: options.border,
    gutter: options.gutter,
    head: options.head,
    chars: boxChars(palette.unicode),
    ellipsis: palette.unicode ? '…' : '...',
    muted: palette.colors.muted,
    bold: palette.colors.bold,
  }
}

/** Terminal rows the header/border chrome occupies (so the live window can size its body). */
export const chromeRows = (border: TableDef.Border, head: boolean): number => {
  let rows = border === 'full' ? 2 : 0
  if (head) {
    rows += border === 'full' || border === 'header' ? 2 : 1
  }
  return rows
}

export const topBorder = (layout: Helpers.Layout): string =>
  fullRule(layout, [layout.chars.tl, layout.chars.tm, layout.chars.tr])

export const bottomBorder = (layout: Helpers.Layout): string =>
  fullRule(layout, [layout.chars.bl, layout.chars.bm, layout.chars.br])

/** The line under the header: a box mid-rule for `full`, an underline for `header`. */
export const separator = (layout: Helpers.Layout): string => {
  if (layout.border === 'full') {
    return fullRule(layout, [layout.chars.ml, layout.chars.mm, layout.chars.mr])
  }
  return layout.muted(
    layout.widths.map(width => layout.chars.h.repeat(width)).join(' '.repeat(layout.gutter)),
  )
}

export const headerRow = (layout: Helpers.Layout): string =>
  joinCells(
    layout,
    styledCells(
      layout,
      layout.headers,
      layout.headers.map(() => layout.bold),
    ),
  )

export const bodyRow = (layout: Helpers.Layout, row: TableDef.Row): string => {
  const cells = layout.columns.map((column, index) => cellText(column, row, index))
  return joinCells(layout, styledCells(layout, cells, layout.colors))
}

export const moreNote = (layout: Helpers.Layout, hidden: number): string =>
  layout.muted(`  ${layout.ellipsis} +${hidden} more row${hidden === 1 ? '' : 's'}`)

/** Assemble a full frame; with `maxBody` set, only the last rows are shown plus a `+N more` note. */
export const frame = (spec: {
  layout: Helpers.Layout
  rows: readonly TableDef.Row[]
  maxBody?: number | undefined
}): { text: string; hidden: number } => {
  const { layout, rows, maxBody } = spec

  const hidden = maxBody !== undefined && rows.length > maxBody ? rows.length - maxBody : 0
  const visible = hidden > 0 ? rows.slice(rows.length - maxBody!) : rows

  const lines: string[] = []
  if (layout.border === 'full') {
    lines.push(topBorder(layout))
  }
  if (layout.head) {
    lines.push(headerRow(layout))
    if (layout.border === 'full' || layout.border === 'header') {
      lines.push(separator(layout))
    }
  }
  for (const row of visible) {
    lines.push(bodyRow(layout, row))
  }
  if (layout.border === 'full') {
    lines.push(bottomBorder(layout))
  }
  if (hidden > 0) {
    lines.push(moreNote(layout, hidden))
  }

  return { text: lines.join('\n'), hidden }
}
