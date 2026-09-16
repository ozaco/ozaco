/**
 * `FutureFlow.done` is the async side as a whole: it settles when the LAST open `for await`
 * iteration ends, not the first.
 */
import { createFutureFlow, flowOf, run, sleep, until, useScope } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

const ticks = (count: number, gapMs: number) =>
  flowOf<number>(function* (emit) {
    for (let i = 0; i < count; i += 1) {
      yield* sleep(gapMs)
      yield* emit(i)
    }
  })

describe('future-flow — done', () => {
  it('settles after the last concurrent iteration, not the first that breaks', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const flow = createFutureFlow(scope, ticks(4, 10))

        const short = (async () => {
          for await (const _ of flow) {
            break
          }
          return 'short'
        })()
        const long = (async () => {
          const got: number[] = []
          for await (const value of flow) {
            got.push(value)
          }
          return `long:${got.length}`
        })()

        const first = yield* until(Promise.race([flow.done.then(() => 'done'), long]))
        expect(first).toBe('long:4')

        yield* until(Promise.all([short, long]))
        expect(yield* until(flow.done.then(() => 'done'))).toBe('done')
      }),
    )
  })

  it('a single iteration still settles it when it completes', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const flow = createFutureFlow(scope, ticks(2, 5))

        const seen: number[] = []
        yield* until(
          (async () => {
            for await (const value of flow) {
              seen.push(value)
            }
          })(),
        )

        expect(seen).toEqual([0, 1])
        expect(yield* until(flow.done.then(() => 'done'))).toBe('done')
      }),
    )
  })

  it('cancel() settles it while iterations are still open', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const flow = createFutureFlow(scope, ticks(100, 5))

        const loop = (async () => {
          let count = 0
          for await (const _ of flow) {
            count += 1
          }
          return count
        })()

        yield* sleep(20)
        yield* flow.cancel()
        expect(yield* until(flow.done.then(() => 'done'))).toBe('done')
        expect(yield* until(loop)).toBeLessThan(100)
      }),
    )
  })
})
