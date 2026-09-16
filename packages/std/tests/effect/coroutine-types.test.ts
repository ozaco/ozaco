/**
 * `Helpers.Coroutine` says what the implementation does: `data.iterator` is the operation's
 * generator (created on first access) and `step()` may yield a raised `Failure` next to effects.
 * Nothing here needs a cast — that is the point.
 */
import type { Helpers } from 'std:effect'
import { run, useScope } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

import { createCoroutine } from '../../src/effect/internal/coroutine'

describe('coroutine — type/runtime agreement', () => {
  it('step() yields a Failure the reducer branches on; data.iterator is the generator', async () => {
    unwrap(
      await run(function* () {
        const scope = yield* useScope()
        const routine = createCoroutine<number>({
          scope,
          operation: () => ({
            *[Symbol.iterator]() {
              yield fail('test.step', 'raised from the body')
              return 1
            },
          }),
        })

        // typed access, no cast: the iterator is created lazily and is a real generator
        const iterator: Iterator<Helpers.Step, number, unknown> = routine.data.iterator
        expect(typeof iterator.next).toBe('function')

        const step: IteratorResult<Helpers.Step, number> = routine.step()
        expect(step.done).toBe(false)
        expect(!step.done && isFailure(step.value)).toBe(true)
        if (!step.done && isFailure(step.value)) {
          expect(step.value.error).toBe('test.step')
        }
      }),
    )
  })
})
