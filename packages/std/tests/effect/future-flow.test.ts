import type { Flow } from 'std:effect'
import { createFutureFlow, isFutureFlow, run, sleep, until, useScope } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * FutureFlow: the Future idea applied to streams — ONE value that is a Flow (`yield*`, paced and
 * cancelled by the consuming scope) AND an async iterable (`for await`, a demand-pulled pump as
 * a detached task of the creating scope). `cancel()` is a Future; `done` settles when the async
 * side finished.
 */

/** `n` increasing values; `produced()` reports how far the producer actually advanced. */
const counting = (n: number, everyMs = 0) => {
  let produced = 0

  const flow: Flow<number, void> = {
    *[Symbol.iterator]() {
      let at = 0
      return {
        *next() {
          if (at >= n) {
            return { done: true as const, value: undefined }
          }
          if (everyMs > 0) {
            yield* sleep(everyMs)
          }
          produced += 1
          return { done: false as const, value: at++ }
        },
      }
    },
  }

  return { flow, produced: () => produced }
}

const failing = (after: number): Flow<number, void> => ({
  *[Symbol.iterator]() {
    let at = 0
    return {
      *next() {
        if (at >= after) {
          return yield* fail('flow.boom', 'asked to fail')
        }
        return { done: false as const, value: at++ }
      },
    }
  },
})

describe('FutureFlow', () => {
  it('is a plain Flow on the sync side — `yield*` drains it inline', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const hybrid = createFutureFlow(scope, counting(3).flow)
        expect(isFutureFlow(hybrid)).toBe(true)

        const seen: number[] = []
        const subscription = yield* hybrid

        for (;;) {
          const step = yield* subscription.next()

          if (step.done) {
            break
          }

          seen.push(step.value)
        }

        expect(seen).toEqual([0, 1, 2])
      }),
    )
  })

  it('is `for await`-able on the async side, in order, and `done` settles at the end', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const hybrid = createFutureFlow(scope, counting(3).flow)

        yield* until(
          (async () => {
            const seen: number[] = []

            for await (const value of hybrid) {
              seen.push(value)
            }

            expect(seen).toEqual([0, 1, 2])
            unwrap(await hybrid.done)
          })(),
        )
      }),
    )
  })

  it('pulls strictly on demand — the producer advances one step per `next()`', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const { flow, produced } = counting(100)
        const hybrid = createFutureFlow(scope, flow)

        yield* until(
          (async () => {
            const iterator = hybrid[Symbol.asyncIterator]()
            const first = await iterator.next()
            const second = await iterator.next()
            expect(first.value).toBe(0)
            expect(second.value).toBe(1)
            expect(produced()).toBe(2)
            await iterator.return!()
          })(),
        )
      }),
    )
  })

  it('breaking out of `for await` halts the pump; the producer stops', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const { flow, produced } = counting(100_000, 1)
        const hybrid = createFutureFlow(scope, flow)

        yield* until(
          (async () => {
            for await (const value of hybrid) {
              if (value >= 2) {
                break
              }
            }
          })(),
        )

        const at = produced()
        yield* sleep(20)
        expect(produced()).toBe(at)
        yield* hybrid.done
      }),
    )
  })

  it('`cancel()` is a Future — awaitable, and it ends open iterations cleanly', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const hybrid = createFutureFlow(scope, counting(100_000, 1).flow)

        yield* until(
          (async () => {
            const iterator = hybrid[Symbol.asyncIterator]()
            const first = await iterator.next()
            expect(first.value).toBe(0)
            unwrap(await hybrid.cancel())
            const after = await iterator.next()
            expect(after.done).toBe(true)
            unwrap(await hybrid.done)
          })(),
        )
      }),
    )
  })

  it('`cancel()` is also `yield*`able from effect world', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const hybrid = createFutureFlow(scope, counting(100_000, 1).flow)

        // open an async consumer, then cancel from the effect side
        const opened = (async () => {
          const seen: number[] = []

          for await (const value of hybrid) {
            seen.push(value)
          }

          return seen
        })()

        yield* sleep(10)
        yield* hybrid.cancel()
        const seen = yield* until(opened)
        expect(seen.length).toBeGreaterThan(0)
        yield* hybrid.done
      }),
    )
  })

  it('a failing flow fails the async iterator with the failure itself', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const hybrid = createFutureFlow(scope, failing(2))

        yield* until(
          (async () => {
            const seen: number[] = []
            const caught = await (async () => {
              for await (const value of hybrid) {
                seen.push(value)
              }
              return null
            })().catch((error: unknown) => error)

            expect(seen).toEqual([0, 1])
            expect(isFailure(caught)).toBe(true)
            expect((caught as { error: string }).error).toBe('flow.boom')
          })(),
        )
      }),
    )
  })

  it('the sync side alone never settles `done`; `cancel()` does', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const hybrid = createFutureFlow(scope, counting(2).flow)

        // drain as a plain Flow
        const subscription = yield* hybrid
        while (!(yield* subscription.next()).done) {
          // drain
        }

        let settled = false
        void hybrid.done.then(() => {
          settled = true
          return null
        })
        yield* sleep(10)
        expect(settled).toBe(false)

        yield* hybrid.cancel()
        yield* hybrid.done
      }),
    )
  })
})
