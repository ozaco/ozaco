import { describe, expect, it } from 'bun:test'

import { ensure, run, scoped, spawn, suspend, until } from '@ozaco/std/effect'
import { isFailure } from '@ozaco/std/result'

// B1: a shutdown where one teardown step fails must still run every other teardown — a failed
// Gateway/Broker destroy can never skip the Pool close that keeps an embedded engine from
// panicking the exit.
describe('scope teardown isolation', () => {
  it('a failing ensure does not skip the remaining ensures', async () => {
    const ran: string[] = []

    const result = await run(() =>
      scoped(function* () {
        yield* ensure(function* () {
          ran.push('first')
        })
        yield* ensure(function* () {
          ran.push('second')
          throw new Error('teardown boom')
        })
        yield* ensure(function* () {
          ran.push('third')
        })
      }),
    )

    // reverse registration order, and every destructor ran despite the middle failure
    expect(ran).toEqual(['third', 'second', 'first'])
    // the teardown failure still surfaces instead of being swallowed
    expect(isFailure(result)).toBe(true)
  })

  it('a spawned task whose teardown fails does not skip later ensures', async () => {
    const ran: string[] = []

    await run(() =>
      scoped(function* () {
        yield* ensure(function* () {
          ran.push('pool-close')
        })
        const started = Promise.withResolvers<void>()
        yield* spawn(function* () {
          started.resolve()
          try {
            yield* suspend()
          } finally {
            ran.push('task-teardown')
            // oxlint-disable-next-line no-unsafe-finally
            throw new Error('task teardown boom')
          }
        })
        // an unstarted generator's `return()` skips its body entirely — wait until the task is
        // genuinely suspended so its teardown is what the scope must unwind
        yield* until(started.promise)
      }),
    )

    expect(ran).toEqual(['task-teardown', 'pool-close'])
  })
})
