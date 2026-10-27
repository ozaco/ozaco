import { attempt, run } from 'std:effect'
import { IO, IOErrors } from 'std:io'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { BunIO } from 'std:io/impl/bun'
import { NodeIO } from 'std:io/impl/node'

// `processAlive` / `signal` reach ANY pid, not only a child this handle spawned — the signal-0
// probe and `process.kill`, folded through the IOErrors matchers (ESRCH → not-found, EPERM →
// access-denied).

const errorOf = (outcome: unknown): string =>
  isFailure(outcome) ? (outcome.error as string) : 'no-failure'

describe.each([
  ['BunIO', BunIO],
  ['NodeIO', NodeIO],
] as const)('%s: processAlive / signal', (_, impl) => {
  it('answers true for this process and for pid 1, false for a pid that has exited', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      const child = yield* IO.actions.spawn('true', [], { stdio: 'ignore' })
      const whileRunning = yield* IO.actions.processAlive(child.pid)

      yield* child.exited()

      return {
        self: yield* IO.actions.processAlive(process.pid),
        // pid 1 exists on every unix; as a non-root user the probe answers EPERM, which still
        // means "alive"
        init: yield* IO.actions.processAlive(1),
        whileRunning,
        afterExit: yield* IO.actions.processAlive(child.pid),
      }
    })

    expect(unwrap(outcome)).toEqual({
      self: true,
      init: true,
      whileRunning: true,
      afterExit: false,
    })
  })

  it('signal terminates a child by pid (default SIGTERM), a named signal is honoured', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      const first = yield* IO.actions.spawn('sleep', ['30'], { stdio: 'ignore' })
      const second = yield* IO.actions.spawn('sleep', ['30'], { stdio: 'ignore' })

      yield* IO.actions.signal(first.pid)
      yield* IO.actions.signal(second.pid, 'SIGKILL')

      return {
        first: (yield* first.exited()).signal,
        second: (yield* second.exited()).signal,
      }
    })

    expect(unwrap(outcome)).toEqual({ first: 'SIGTERM', second: 'SIGKILL' })
  })

  it('signal to a pid nobody has fails std:io.not-found', async () => {
    const outcome = await run(function* () {
      yield* impl.use()

      const child = yield* IO.actions.spawn('true', [], { stdio: 'ignore' })

      yield* child.exited()

      return errorOf(yield* attempt(() => IO.actions.signal(child.pid)))
    })

    expect(unwrap(outcome)).toBe(IOErrors.NotFound)
  })
})
