/**
 * Tables in both modes: a non-interactive output buffers every row and fits the columns to all of
 * them on `end()` (no cell cut down to its header width), and the live handle can remove or
 * replace rows — redrawn in place on a tty, reflected in the single write of a pipe.
 */
import { DefaultPalette } from 'cli:palette'
import { DefaultTable, Table } from 'cli:table'
import type { Operation } from 'std:effect'
import { run } from 'std:effect'
import { unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { createMemoryScreen, MemoryTerminal } from 'cli:impl/memory'

const boot = <T>(
  screen: ReturnType<typeof createMemoryScreen>,
  body: () => Operation<T>,
): Promise<AnyType> =>
  run(function* () {
    yield* MemoryTerminal.use({ screen })
    yield* DefaultPalette.use()
    yield* DefaultTable.use()

    return yield* body()
  })

const pipe = (columns?: number) =>
  createMemoryScreen({
    ...(columns === undefined ? {} : { columns }),
    capabilities: { interactive: false, unicode: false },
  })

const LONG = 'a-much-longer-cell-than-its-header'

describe('cli — table (non-interactive)', () => {
  it('fits columns to every row instead of truncating to the header width', async () => {
    const screen = pipe()

    unwrap(
      await boot(screen, function* () {
        const table = yield* Table.actions.table({ columns: [{ key: 'id', header: 'Id' }] })
        yield* table.row({ id: 'x' })
        yield* table.row({ id: LONG })
        // nothing is written before `end()`
        expect(screen.plain()).toBe('')
        yield* table.end()
      }),
    )

    const out = screen.plain()
    expect(out).toContain(`| ${LONG} |`)
    expect(out).not.toContain('...')
    expect(out.split('\n').filter(line => line.startsWith('+'))).toHaveLength(3)
  })

  it('does not truncate in a pipe with an unknown width', async () => {
    const screen = pipe()
    const wide = 'x'.repeat(200)

    unwrap(
      await boot(screen, function* () {
        const table = yield* Table.actions.table({ columns: [{ header: 'Data' }], border: 'none' })
        yield* table.row([wide])
        yield* table.end()
      }),
    )

    expect(screen.plain()).toBe(`Data${' '.repeat(196)}\n${wide}\n`)
  })

  it('still respects a known terminal width', async () => {
    const screen = pipe(20)

    unwrap(
      await boot(screen, function* () {
        const table = yield* Table.actions.table({ columns: [{ header: 'Data' }], border: 'none' })
        yield* table.row(['y'.repeat(50)])
        yield* table.end()
      }),
    )

    const lines = screen.plain().trimEnd().split('\n')
    expect(lines[1]).toBe(`${'y'.repeat(17)}...`)
  })

  it('edits, removes and replaces buffered rows before the single write', async () => {
    const screen = pipe()

    unwrap(
      await boot(screen, function* () {
        const table = yield* Table.actions.table({
          columns: [{ key: 'name', header: 'Name' }],
          border: 'none',
          head: false,
        })
        yield* table.rows([{ name: 'ada' }, { name: 'grace' }, { name: 'linus' }])
        yield* table.update(0, { name: 'ada lovelace' })
        yield* table.remove(1)
        yield* table.end()
      }),
    )

    expect(screen.plain()).toBe('ada lovelace\nlinus       \n')

    const replaced = pipe()
    unwrap(
      await boot(replaced, function* () {
        const table = yield* Table.actions.table({
          columns: [{ key: 'n' }],
          head: false,
          border: 'none',
        })
        yield* table.rows([{ n: 1 }, { n: 2 }])
        yield* table.replace([{ n: 9 }])
        yield* table.set(0, 'n', 10)
        yield* table.end()
      }),
    )

    expect(replaced.plain()).toBe('10\n')
  })
})

describe('cli — table (interactive)', () => {
  it('remove redraws the live window and clears the leftover line', async () => {
    const screen = createMemoryScreen({ columns: 40, capabilities: { unicode: false } })

    unwrap(
      await boot(screen, function* () {
        const table = yield* Table.actions.table({
          columns: [{ key: 'name', header: 'Name' }],
          border: 'none',
          head: false,
        })
        yield* table.rows([{ name: 'one' }, { name: 'two' }, { name: 'three' }])
        screen.clear()

        yield* table.remove(1)
        const redraw = screen.read()
        // erase the 3-row frame (cursor up 2 + erase down), then draw the 2-row one
        expect(redraw).toContain(`${String.fromCodePoint(27)}[2A${String.fromCodePoint(27)}[J`)
        expect(screen.plain()).toBe('one  \nthree')

        screen.clear()
        yield* table.replace([{ name: 'fresh' }])
        expect(screen.plain()).toBe('fresh')

        yield* table.end()
      }),
    )

    expect(screen.plain().endsWith('fresh\n')).toBe(true)
  })
})
