import { every, attempt, run, sleep, spawn } from 'std:effect'
import type { Result } from 'std:result'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('every', () => {
  it('runs now and again every ms; a handled failure keeps the loop going, an unhandled one ends it', async () => {
    unwrap(
      await run(function* () {
        let rounds = 0
        const handled: unknown[] = []
        const task = yield* spawn(() =>
          every(
            5,
            function* () {
              rounds += 1

              if (rounds === 2) {
                return yield* fail('every-test.boom', 'round two')
              }
            },
            {
              *onFailure(failure: Result.Failure<unknown>) {
                handled.push(failure.error)
              },
            },
          ),
        )

        yield* sleep(60)
        yield* task.halt()

        expect(rounds).toBeGreaterThanOrEqual(3)
        expect(handled).toEqual(['every-test.boom'])

        const ended = yield* attempt(() =>
          every(5, function* () {
            return yield* fail('every-test.stop', 'no handler')
          }),
        )

        expect(isFailure(ended) && ended.error).toBe('every-test.stop')
      }),
    )
  })
})
