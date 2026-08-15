import type { PaletteDef } from 'cli:palette'

import type { TableDef } from './table'

export interface BoxChars {
  h: string
  v: string
  tl: string
  tm: string
  tr: string
  ml: string
  mm: string
  mr: string
  bl: string
  bm: string
  br: string
}

export interface Normalized {
  columns: TableDef.Column[]
  border: TableDef.Border
  gutter: number
  head: boolean
  window: number | undefined
}

export interface Layout {
  columns: TableDef.Column[]
  headers: string[]
  widths: number[]
  aligns: TableDef.Align[]
  colors: (PaletteDef.Style | undefined)[]
  border: TableDef.Border
  gutter: number
  head: boolean
  chars: BoxChars
  ellipsis: string
  muted: PaletteDef.Style
  bold: PaletteDef.Style
}

export type MutableRow = TableDef.Cell[] | Record<string, TableDef.Cell>
