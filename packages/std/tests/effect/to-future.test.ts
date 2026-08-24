import { run, sleep, toFuture, until, useScope } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * toFuture: an operation as a hybrid Future — the value IS the operation (`yield*` runs it
 * inline in the caller's task), and `then`/`catch`/`finally` each start a FRESH detached task
 * of the given scope, settling a `Result` (failures resolve, per the std contract). `hold`
 * keeps an awaited task alive past the value; `signal` halts it.
 */
describe('toFuture', () => {
  it('`yield*` runs the operation INLINE — every yield* is a fresh run', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        let runs = 0

        const future = toFuture(scope, function* () {
          runs += 1
          return runs
        })

        expect(yield* future).toBe(1)
        expect(yield* future).toBe(2)
        expect(runs).toBe(2)
      }),
    )
  })

  it('`await` is lazy and SYMMETRIC with `yield*` — every await is its own run', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        let runs = 0

        const future = toFuture(scope, function* () {
          runs += 1
          return 'value'
        })

        yield* sleep(5)
        expect(runs).toBe(0) // untouched → nothing ran

        yield* until(
          (async () => {
            expect(unwrap(await future)).toBe('value')
            expect(unwrap(await future)).toBe('value') // a fresh run, same as a second yield*
          })(),
        )

        expect(runs).toBe(2)
      }),
    )
  })

  it('a failing operation RESOLVES the failure (never rejects) — `unwrap` throws it', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()

        const future = toFuture(scope, function* () {
          return yield* fail('to-future.boom', 'asked to fail')
        })

        yield* until(
          (async () => {
            const outcome = await future
            expect(isFailure(outcome)).toBe(true)
            expect((outcome as { error: string }).error).toBe('to-future.boom')
          })(),
        )
      }),
    )
  })

  it('`signal` halts the awaited task; the future settles `halted`', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const controller = new AbortController()
        let finished = false

        const future = toFuture(
          scope,
          function* () {
            yield* sleep(5000)
            finished = true
          },
          { signal: controller.signal },
        )

        yield* until(
          (async () => {
            const pending = future.then(outcome => outcome)
            controller.abort()
            const outcome = await pending
            expect(isFailure(outcome)).toBe(true)
            expect((outcome as { error: string }).error).toBe('halted')
          })(),
        )

        expect(finished).toBe(false)
      }),
    )
  })

  it('an already-aborted signal settles `halted` without running anything', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const controller = new AbortController()
        controller.abort()
        let runs = 0

        const future = toFuture(
          scope,
          function* () {
            runs += 1
          },
          { signal: controller.signal },
        )

        yield* until(
          (async () => {
            const outcome = await future
            expect((outcome as { error: string }).error).toBe('halted')
          })(),
        )

        expect(runs).toBe(0)
      }),
    )
  })

  it('`hold` keeps the awaited task alive AFTER the value settles', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        let released = false
        let release: () => void = () => {}

        const gate = new Promise<void>(resolve => {
          release = resolve
        })

        const future = toFuture(scope, () => sleepThen('value'), {
          hold: () =>
            (function* () {
              yield* until(gate)
              released = true
            })(),
        })

        yield* until(
          (async () => {
            expect(unwrap(await future)).toBe('value')
          })(),
        )

        // the value settled but the task still holds
        yield* sleep(10)
        expect(released).toBe(false)

        release()
        yield* sleep(10)
        expect(released).toBe(true)
      }),
    )
  })
})

function* sleepThen<T>(value: T) {
  yield* sleep(1)
  return value
}
