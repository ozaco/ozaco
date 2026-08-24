import { each, flowOf, run, sleep } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * flowOf: a Flow as ONE generator — `emit` sends items, a plain `return` ends the flow with its
 * close value, a raised failure closes the flow with the failure, and the producer dies with
 * the consuming scope.
 */
describe('flowOf', () => {
  it('emits, then a plain return ends the flow (its value is the close value)', async () => {
    unwrap(
      await run(function* () {
        const flow = flowOf<number, string>(function* (emit) {
          yield* emit(1)
          yield* emit(2)
          yield* sleep(1)
          yield* emit(3)
          return 'done'
        })

        const seen: number[] = []
        const subscription = yield* flow

        for (;;) {
          const step = yield* subscription.next()

          if (step.done) {
            expect(step.value).toBe('done')
            break
          }

          seen.push(step.value)
        }

        expect(seen).toEqual([1, 2, 3])
      }),
    )
  })

  it('works with each()', async () => {
    unwrap(
      await run(function* () {
        const flow = flowOf<number>(function* (emit) {
          for (let at = 0; at < 3; at += 1) {
            yield* emit(at)
          }
        })

        const seen: number[] = []

        for (const value of yield* each(flow)) {
          seen.push(value)
          yield* each.next()
        }

        expect(seen).toEqual([0, 1, 2])
      }),
    )
  })

  it('a raised failure closes the flow WITH the failure', async () => {
    unwrap(
      await run(function* () {
        const flow = flowOf<number>(function* (emit) {
          yield* emit(1)
          yield* fail('flow-of.boom', 'asked to fail')
        })

        const subscription = yield* flow
        const first = yield* subscription.next()
        expect(first).toEqual({ done: false, value: 1 })
        const closed = yield* subscription.next()
        expect(closed.done).toBe(true)
        expect(isFailure(closed.value)).toBe(true)
        expect((closed.value as unknown as { error: string }).error).toBe('flow-of.boom')
      }),
    )
  })

  it('the producer dies with the consuming scope', async () => {
    let produced = 0

    unwrap(
      await run(function* () {
        const flow = flowOf<number>(function* (emit) {
          for (;;) {
            produced += 1
            yield* emit(produced)
            yield* sleep(1)
          }
        })

        const subscription = yield* flow
        yield* subscription.next()
        yield* subscription.next()
      }),
    )

    const at = produced
    await new Promise(resolve => {
      setTimeout(resolve, 20)
    })
    expect(produced).toBe(at)
  })
})
