import { Terminal, useTerminal } from 'cli:core'
import { usePalette } from 'cli:palette'
import type { Operation } from 'std:effect'
import { ensure } from 'std:effect'

import type { Helpers } from '../types/helpers'
import type { TableDef } from '../types/table'

import { chromeRows, frame, makeLayout, normalize } from './format'

/** Reserve rows for the `+N more` note and one line of breathing room below the live table. */
const RESERVED_ROWS = 2

const clone = (row: TableDef.Row): Helpers.MutableRow =>
  Array.isArray(row)
    ? [...(row as readonly TableDef.Cell[])]
    : { ...(row as Record<string, TableDef.Cell>) }

const setCell = (
  cells: Helpers.MutableRow,
  column: string | number,
  value: TableDef.Cell,
): void => {
  if (Array.isArray(cells)) {
    cells[Number(column)] = value
  } else {
    cells[String(column)] = value
  }
}

/**
 * The handle over the row buffer — shared by both modes: every edit changes `state.rows`, then
 * `refresh` repaints (the interactive live window) or does nothing (non-interactive output is
 * written once, on `end()`). Edits after `end()` are ignored.
 */
const edits = (
  state: Helpers.TableState,
  repaint: (() => Operation<void>) | undefined,
  finish: () => Operation<void>,
): TableDef.Handle => {
  function* refresh() {
    if (repaint !== undefined && !state.ended) {
      yield* repaint()
    }
  }

  return {
    *row(row: TableDef.Row) {
      const index = state.rows.push(clone(row)) - 1
      yield* refresh()
      return index
    },
    *rows(rows: TableDef.Row[]) {
      const start = state.rows.length
      for (const row of rows) {
        state.rows.push(clone(row))
      }
      yield* refresh()
      return Array.from(rows.keys(), offset => start + offset)
    },
    *update(index: number, row: TableDef.Row) {
      if (state.ended || state.rows[index] === undefined) {
        return
      }
      state.rows[index] = clone(row)
      yield* refresh()
    },
    *set(index: number, column: string | number, value: TableDef.Cell) {
      const cells = state.rows[index]
      if (state.ended || cells === undefined) {
        return
      }
      setCell(cells, column, value)
      yield* refresh()
    },
    *remove(index: number) {
      if (state.ended || state.rows[index] === undefined) {
        return
      }
      state.rows.splice(index, 1)
      yield* refresh()
    },
    *replace(rows: TableDef.Row[]) {
      if (state.ended) {
        return
      }
      state.rows = rows.map(clone)
      yield* refresh()
    },
    end: finish,
  }
}

export function* table(options: TableDef.Options) {
  const info = yield* useTerminal()
  const palette = yield* usePalette()
  const size = yield* Terminal.actions.size()

  const opts = normalize(options)
  const state: Helpers.TableState = { rows: [], ended: false }

  // Interactive: keep every row, auto-fit columns, and re-render the table in place through the
  // render lease — so any row stays editable until `end()`. When the table outgrows the viewport
  // only the last rows that fit are shown (plus a `+N more` note); `end()` clears the live window
  // and commits the full table.
  if (info.capabilities.interactive) {
    const lease = yield* Terminal.actions.renderer()
    const chrome = chromeRows(opts.border, opts.head)
    const fit = Math.max(1, size.rows - chrome - RESERVED_ROWS)
    const maxBody = opts.window === undefined ? fit : Math.min(opts.window, fit)

    const draw = function* () {
      const layout = makeLayout({
        options: opts,
        rows: state.rows,
        palette,
        termColumns: size.columns,
      })
      yield* lease.render(frame({ layout, rows: state.rows, maxBody }).text)
    }

    const finish = function* () {
      if (state.ended) {
        return
      }
      state.ended = true
      const layout = makeLayout({
        options: opts,
        rows: state.rows,
        palette,
        termColumns: size.columns,
      })
      yield* lease.done(frame({ layout, rows: state.rows }).text)
    }

    yield* draw()
    yield* ensure(function* () {
      yield* finish()
    })

    return edits(state, draw, finish)
  }

  // Non-interactive (pipe/CI): rows are BUFFERED and the whole table is written once on `end()`
  // — plain text, no cursor codes, so no lease — with column widths fitted to EVERY row. Streaming
  // line by line would fix the widths before the data is known and truncate every later cell to
  // its header. A known terminal width still bounds the table; a pipe with no width never
  // truncates.
  const termColumns = size.fallback === true ? Number.POSITIVE_INFINITY : size.columns

  const finish = function* () {
    if (state.ended) {
      return
    }
    state.ended = true
    const layout = makeLayout({ options: opts, rows: state.rows, palette, termColumns })
    const text = frame({ layout, rows: state.rows }).text
    if (text !== '') {
      yield* Terminal.actions.write(`${text}\n`)
    }
  }

  yield* ensure(function* () {
    yield* finish()
  })

  return edits(state, undefined, finish)
}
