/**
 * The `Terminal` protocol, end to end over the in-memory binding: the output path, the session
 * lifecycle (raw mode on, keys flowing, EVERYTHING restored on the way out), the capability gate
 * on `resize`, and the live-region lease core builds on top of it.
 */
import { CliErrors, Terminal } from 'cli:core'
import type { Operation } from 'std:effect'
import { attempt, race, run, sleep } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'
import type { AnyType } from 'std:shared'

import { describe, expect, it } from 'bun:test'

import { createMemoryScreen, MemoryTerminal } from 'cli:impl/memory'

const ESC = String.fromCodePoint(27)

const withTerminal = <T>(
  screen: ReturnType<typeof createMemoryScreen>,
  body: () => Operation<T>,
): Promise<AnyType> =>
  run(function* () {
    yield* MemoryTerminal.use({ screen })

    return yield* body()
  })

describe('cli — terminal', () => {
  it('writes, sizes, and reports what the screen was built with', async () => {
    const screen = createMemoryScreen({ columns: 100, rows: 30 })

    unwrap(
      await withTerminal(screen, function* () {
        yield* Terminal.actions.write('hello ')
        yield* Terminal.actions.write('world')

        expect(yield* Terminal.actions.size()).toEqual({ columns: 100, rows: 30 })

        const info = yield* Terminal.context.expect()
        expect(info.terminal).toBe('memory')
        expect(info.capabilities.interactive).toBe(true)
      }),
    )

    expect(screen.read()).toBe('hello world')
  })

  it('strips escape sequences out of `plain()` — what a person would see', async () => {
    const screen = createMemoryScreen()

    unwrap(
      await withTerminal(screen, function* () {
        yield* Terminal.actions.write(`${ESC}[31mred${ESC}[39m`)
      }),
    )

    expect(screen.read()).toContain(`${ESC}[31m`)
    expect(screen.plain()).toBe('red')
  })

  it('delivers keys inside a session, and refuses them outside one', async () => {
    const screen = createMemoryScreen()

    const outcome = await withTerminal(screen, function* () {
      const before = yield* attempt(() => Terminal.actions.keys())
      expect(isFailure(before) && before.error).toBe(CliErrors.Terminal)

      return yield* Terminal.actions.session(function* () {
        expect(screen.raw).toBe(true)

        // a Flow is subscribed with a second `yield*` (core does the same in its renderer)
        const keys = yield* yield* Terminal.actions.keys()
        screen.press('down', 'a', 'enter')

        const seen: string[] = []

        for (let at = 0; at < 3; at += 1) {
          const step = yield* keys.next()
          seen.push((step.value as { name: string }).name)
        }

        return seen
      })
    })

    expect(unwrap(outcome) as readonly string[]).toEqual(['down', 'a', 'return'])
    // raw mode is off again, and the listener is detached
    expect(screen.raw).toBe(false)
  })

  it('restores raw mode when the session body fails', async () => {
    const screen = createMemoryScreen()

    unwrap(
      await withTerminal(screen, function* () {
        const outcome = yield* attempt(() =>
          Terminal.actions.session(function* () {
            expect(screen.raw).toBe(true)

            return yield* fail(CliErrors.Validation, 'boom')
          }),
        )

        expect(isFailure(outcome) && outcome.error).toBe(CliErrors.Validation)
      }),
    )

    expect(screen.raw).toBe(false)
  })

  it('a platform interrupt cancels the session', async () => {
    const screen = createMemoryScreen()

    unwrap(
      await withTerminal(screen, function* () {
        const outcome = yield* attempt(() =>
          Terminal.actions.session(function* () {
            screen.interrupt()
            yield* sleep(1000)

            return 'never'
          }),
        )

        expect(isFailure(outcome) && outcome.error).toBe(CliErrors.Cancelled)
      }),
    )

    expect(screen.raw).toBe(false)
  })

  it('refuses a second concurrent session', async () => {
    const screen = createMemoryScreen()

    unwrap(
      await withTerminal(screen, function* () {
        yield* Terminal.actions.session(function* () {
          const inner = yield* attempt(() => Terminal.actions.session(() => sleep(0)))
          expect(isFailure(inner) && inner.error).toBe(CliErrors.Busy)
        })
      }),
    )
  })

  it('emits resize when the capability is on, and fails cleanly when it is off', async () => {
    const live = createMemoryScreen()

    const seen = unwrap(
      await withTerminal(live, function* () {
        const flow = yield* yield* Terminal.actions.resize()
        live.setSize({ columns: 42, rows: 7 })

        return yield* race([
          flow.next(),

          (function* () {
            yield* sleep(1000)

            return { value: 'timeout' }
          })(),
        ])
      }),
    ) as AnyType

    expect(seen.value).toEqual({ columns: 42, rows: 7 })

    const flat = createMemoryScreen({ capabilities: { resize: false } })

    unwrap(
      await withTerminal(flat, function* () {
        const refused = yield* attempt(() => Terminal.actions.resize())
        expect(isFailure(refused) && refused.error).toBe(CliErrors.Unsupported)
      }),
    )
  })

  it('drives the live-region lease core builds on the binding', async () => {
    const screen = createMemoryScreen()

    unwrap(
      await withTerminal(screen, function* () {
        const lease = yield* Terminal.actions.renderer()

        yield* lease.render('frame one')
        expect(screen.plain()).toContain('frame one')

        yield* lease.render('frame two')
        expect(screen.plain()).toContain('frame two')

        yield* lease.done('final')
        expect(screen.plain()).toContain('final')

        // the lease is released — a second acquire succeeds instead of failing `cli.busy`
        const again = yield* attempt(() => Terminal.actions.renderer())
        expect(isFailure(again)).toBe(false)
      }),
    )
  })
})
