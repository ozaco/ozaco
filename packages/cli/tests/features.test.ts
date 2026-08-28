import { CliErrors } from 'cli:core'
/**
 * The modules that were unreachable without a terminal binding: a table rendered to the scroll-
 * back, a spinner's live region, and a prompt driven by scripted keystrokes. Each one is the
 * first proof that its module actually runs.
 */
import { Palette, DefaultPalette } from 'cli:palette'
import { DefaultPrompt, Prompt } from 'cli:prompt'
import { DefaultSpinner, Spinner } from 'cli:spinner'
import { DefaultTable, Table } from 'cli:table'
import type { Operation } from 'std:effect'
import { attempt, fork, run, sleep } from 'std:effect'
import { isFailure, unwrap } from 'std:result'
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

    return yield* body()
  })

describe('cli — palette', () => {
  it('follows the terminal it was installed behind', async () => {
    const plain = createMemoryScreen({ capabilities: { color: 'none', unicode: false } })

    unwrap(
      await boot(plain, function* () {
        const context = yield* Palette.context.expect()
        expect(context.color).toBe(false)
        expect(context.unicode).toBe(false)

        // with color off, a style is the identity function — no escape codes leak into output
        const colors = yield* Palette.actions.colors()
        expect(colors.error('boom')).toBe('boom')
      }),
    )

    const rich = createMemoryScreen({ capabilities: { color: 'true', unicode: true } })

    unwrap(
      await boot(rich, function* () {
        const colors = yield* Palette.actions.colors()
        expect(colors.error('boom')).not.toBe('boom')
      }),
    )
  })
})

describe('cli — table', () => {
  it('renders rows to the scrollback, aligned under their headers', async () => {
    const screen = createMemoryScreen({ columns: 60 })

    unwrap(
      await boot(screen, function* () {
        yield* DefaultTable.use()

        const table = yield* Table.actions.table({
          columns: [
            { key: 'name', header: 'Name' },
            { key: 'runs', header: 'Runs', align: 'right' },
          ],
        })

        yield* table.rows([
          { name: 'ada', runs: 36 },
          { name: 'grace', runs: 44 },
        ])
        yield* table.end()
      }),
    )

    const out = screen.plain()
    expect(out).toContain('Name')
    expect(out).toContain('Runs')
    expect(out).toContain('ada')
    expect(out).toContain('grace')
    expect(out).toContain('44')
  })

  it('updates a row that has not been committed yet', async () => {
    const screen = createMemoryScreen()

    unwrap(
      await boot(screen, function* () {
        yield* DefaultTable.use()

        const table = yield* Table.actions.table({ columns: [{ key: 'state', header: 'State' }] })
        const index = yield* table.row({ state: 'pending' })
        yield* table.update(index, { state: 'done' })
        yield* table.end()
      }),
    )

    expect(screen.plain()).toContain('done')
  })
})

describe('cli — spinner', () => {
  it('draws into the live region and commits its final line', async () => {
    const screen = createMemoryScreen()

    unwrap(
      await boot(screen, function* () {
        yield* DefaultSpinner.use()

        const handle = yield* Spinner.actions.start('working')
        yield* sleep(5)
        yield* handle.update('still working')
        yield* handle.succeed('done')
      }),
    )

    const out = screen.plain()
    expect(out).toContain('working')
    expect(out).toContain('done')
  })
})

describe('cli — prompt', () => {
  it('answers a text prompt from scripted keystrokes', async () => {
    const screen = createMemoryScreen()

    const answer: unknown = unwrap(
      await boot(screen, function* () {
        yield* DefaultPrompt.use()

        const asked = yield* fork(() => Prompt.actions.text({ message: 'your name' }))

        // let the prompt paint its first frame before typing into it
        yield* sleep(20)
        screen.type('ada')
        screen.press('enter')

        return yield* asked
      }),
    )

    expect(answer).toBe('ada')
    expect(screen.plain()).toContain('your name')
  })

  it('moves a select with the arrow keys', async () => {
    const screen = createMemoryScreen()

    const picked: unknown = unwrap(
      await boot(screen, function* () {
        yield* DefaultPrompt.use()

        const asked = yield* fork(() =>
          Prompt.actions.select({
            message: 'pick one',
            choices: [
              { label: 'first', value: 1 },
              { label: 'second', value: 2 },
              { label: 'third', value: 3 },
            ],
          }),
        )

        yield* sleep(20)
        screen.press('down', 'down', 'enter')

        return yield* asked
      }),
    )

    expect(picked).toBe(3)
  })

  it('ctrl+c cancels a prompt instead of hanging it', async () => {
    const screen = createMemoryScreen()

    unwrap(
      await boot(screen, function* () {
        yield* DefaultPrompt.use()

        const asked = yield* fork(() =>
          attempt(() => Prompt.actions.text({ message: 'your name' })),
        )

        yield* sleep(20)
        screen.press('ctrl+c')

        const outcome = (yield* asked) as AnyType
        expect(isFailure(outcome) && outcome.error).toBe(CliErrors.Cancelled)
      }),
    )

    // and the terminal is left clean
    expect(screen.raw).toBe(false)
  })
})
