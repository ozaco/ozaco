import type { TableDef } from 'cli:core'
import { Palette, Terminal } from 'cli:core'
import { ensure, operation, useContext } from 'std:effect'

import {
  bodyRow,
  bottomBorder,
  chromeRows,
  frame,
  headerRow,
  makeLayout,
  normalize,
  separator,
  topBorder,
} from './format'

/** Reserve rows for the `+N more` note and one line of breathing room below the live table. */
const RESERVED_ROWS = 2

type MutableRow = TableDef.Cell[] | Record<string, TableDef.Cell>

const clone = (row: TableDef.Row): MutableRow =>
  Array.isArray(row)
    ? [...(row as readonly TableDef.Cell[])]
    : { ...(row as Record<string, TableDef.Cell>) }

const setCell = (cells: MutableRow, column: string | number, value: TableDef.Cell): void => {
  if (Array.isArray(cells)) {
    cells[Number(column)] = value
  } else {
    cells[String(column)] = value
  }
}

export const table = operation(function* (options: TableDef.Options) {
  const ctx = yield* useContext(Terminal)
  const palette = yield* useContext(Palette)
  const size = yield* Terminal.actions.size()

  const opts = normalize(options)
  const state = { rows: [] as MutableRow[], ended: false }

  // Interactive: keep every row, auto-fit columns, and re-render the table in place — so any row
  // stays editable until `end()`. When the table outgrows the viewport only the last rows that fit
  // are shown (plus a `+N more` note); `end()` clears the live window and commits the full table.
  if (ctx.interactive) {
    const renderer = yield* Terminal.actions.renderer(size.columns)
    const chrome = chromeRows(opts.border, opts.head)
    const fit = Math.max(1, size.rows - chrome - RESERVED_ROWS)
    const maxBody = opts.window === undefined ? fit : Math.min(opts.window, fit)

    const draw = operation(function* () {
      const layout = makeLayout({
        options: opts,
        rows: state.rows,
        palette,
        termColumns: size.columns,
      })
      yield* renderer.render(frame({ layout, rows: state.rows, maxBody }).text)
    })

    const finish = operation(function* () {
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
      yield* renderer.done(frame({ layout, rows: state.rows }).text)
    })

    yield* draw()
    yield* ensure(function* () {
      yield* finish()
    })

    return {
      row: operation(function* (row: TableDef.Row) {
        const index = state.rows.push(clone(row)) - 1
        yield* draw()
        return index
      }),
      rows: operation(function* (rows: TableDef.Row[]) {
        const start = state.rows.length
        for (const row of rows) {
          state.rows.push(clone(row))
        }
        yield* draw()
        return Array.from(rows.keys(), offset => start + offset)
      }),
      update: operation(function* (index: number, row: TableDef.Row) {
        if (state.ended || state.rows[index] === undefined) {
          return
        }
        state.rows[index] = clone(row)
        yield* draw()
      }),
      set: operation(function* (index: number, column: string | number, value: TableDef.Cell) {
        const cells = state.rows[index]
        if (state.ended || cells === undefined) {
          return
        }
        setCell(cells, column, value)
        yield* draw()
      }),
      end: finish,
    } satisfies TableDef.Handle
  }

  // Non-interactive (pipe/CI): fixed-width, append-only. A row is committed once the next row is
  // appended (or on `end()`), so the most-recent row stays editable while earlier ones are already
  // written and can't change. No cursor control is used, so nothing is ever redrawn.
  const layout = makeLayout({ options: opts, rows: [], palette, termColumns: size.columns })
  const flushed = { value: 0 }
  const started = { value: false }

  const startOnce = operation(function* () {
    if (started.value) {
      return
    }
    started.value = true
    if (opts.border === 'full') {
      ctx.output.write(`${topBorder(layout)}\n`)
    }
    if (opts.head) {
      ctx.output.write(`${headerRow(layout)}\n`)
      if (opts.border === 'full' || opts.border === 'header') {
        ctx.output.write(`${separator(layout)}\n`)
      }
    }
  })

  const flush = operation(function* (all: boolean) {
    const limit = all ? state.rows.length : state.rows.length - 1
    while (flushed.value < limit) {
      yield* startOnce()
      ctx.output.write(`${bodyRow(layout, state.rows[flushed.value]!)}\n`)
      flushed.value += 1
    }
  })

  const finish = operation(function* () {
    if (state.ended) {
      return
    }
    state.ended = true
    yield* flush(true)
    yield* startOnce()
    if (opts.border === 'full') {
      ctx.output.write(`${bottomBorder(layout)}\n`)
    }
  })

  // An update reflects immediately: a not-yet-committed (pending) row is edited in place and
  // flushed later with the new value; an already-committed row can't be rewritten in a pipe, so its
  // new state is RE-APPENDED as a fresh line (duplicates are expected).
  const reflect = operation(function* (index: number) {
    if (index < flushed.value && !state.ended) {
      yield* startOnce()
      ctx.output.write(`${bodyRow(layout, state.rows[index]!)}\n`)
    }
  })

  yield* ensure(function* () {
    yield* finish()
  })

  return {
    row: operation(function* (row: TableDef.Row) {
      const index = state.rows.push(clone(row)) - 1
      yield* flush(false)
      return index
    }),
    rows: operation(function* (rows: TableDef.Row[]) {
      const start = state.rows.length
      for (const row of rows) {
        state.rows.push(clone(row))
      }
      yield* flush(false)
      return Array.from(rows.keys(), offset => start + offset)
    }),
    update: operation(function* (index: number, row: TableDef.Row) {
      if (state.rows[index] === undefined) {
        return
      }
      state.rows[index] = clone(row)
      yield* reflect(index)
    }),
    set: operation(function* (index: number, column: string | number, value: TableDef.Cell) {
      const cells = state.rows[index]
      if (cells === undefined) {
        return
      }
      setCell(cells, column, value)
      yield* reflect(index)
    }),
    end: finish,
  } satisfies TableDef.Handle
})
