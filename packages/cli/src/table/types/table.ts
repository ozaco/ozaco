import type { PaletteDef } from 'cli:palette'
import type { Operation } from 'std:effect'
import type { EmptyType } from 'std:shared'

export namespace TableDef {
  export type Align = 'left' | 'right' | 'center'
  export type Border = 'none' | 'header' | 'full'
  export type Cell = string | number | boolean | null | undefined
  export type Row = readonly Cell[] | Record<string, Cell>

  export interface Column {
    /** Header label (default derived from `key`, else empty). */
    header?: string
    /** Object-row key to read this column from (default: the column index for array rows). */
    key?: string | number
    /** Fixed column width; omit to auto-fit to the widest cell/header. */
    width?: number
    /** Lower/upper bounds for the auto-fit width. */
    min?: number
    max?: number
    /** Cell text alignment (default `'left'`). */
    align?: Align
    /** Style applied to each body cell AFTER padding, so alignment stays correct. */
    color?: PaletteDef.Style
    /** Turn a raw cell value into display text (default `String`, nullish → `''`). */
    format?: (value: Cell) => string
  }

  export interface Options {
    columns: Column[]
    /** Visual style (default `'full'`). */
    border?: Border
    /** Spaces between columns for the borderless styles (default `2`). */
    gutter?: number
    /** Render the header row (default `true`). */
    head?: boolean
    /** Max body rows kept in the live window; defaults to what fits the viewport. */
    window?: number
  }

  export type Context = EmptyType

  export interface Handle {
    /** Append one row; returns its index, to `update`/`set` it later. */
    row(row: Row): Operation<number>
    /** Append many rows at once; returns their indices (in order). */
    rows(rows: Row[]): Operation<number[]>
    /**
     * Replace every cell of the row at `index`. Interactive tables redraw in place; non-interactive
     * tables buffer every row until `end()`, so any row stays editable until then in both modes.
     */
    update(index: number, row: Row): Operation<void>
    /** Update a single cell of the row at `index` — by column key (object rows) or index (arrays). */
    set(index: number, column: string | number, value: Cell): Operation<void>
    /**
     * Remove the row at `index`; the rows after it shift up one index. Interactive tables redraw
     * (leftover lines of the taller frame are cleared).
     */
    remove(index: number): Operation<void>
    /** Replace ALL rows (indices restart at 0) — e.g. a refreshed listing. */
    replace(rows: Row[]): Operation<void>
    /**
     * Commit the table: the full, fully-aligned table is written to the scrollback (for a
     * non-interactive output this is the only write — widths fit every row).
     */
    end(): Operation<void>
  }

  export interface Actions {
    /** Open a streaming table; feed it via the returned handle's `row`/`rows`, close with `end`. */
    table(options: Options): Operation<Handle>
  }
}
