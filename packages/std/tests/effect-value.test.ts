import { describe, expect, it } from 'bun:test'

import type { Operation } from '@ozaco/std/effect'
import { attempt, createQueue, operation, run } from '@ozaco/std/effect'
import { isSuccess, succeed } from '@ozaco/std/result'

// S6: an effect-native value is deliberately thenable (`operation()` defines `then` for await-side
// interop), so `succeed`'s promise-unwrap used to mistake it for an async computation — `.then`
// RAN the operation as a floating task and handed back a Promise, which `attempt` then returned
// where a Result belongs. A lane returned by an action reached `toSources` as `undefined` that way.
describe('effect-native values through succeed/attempt', () => {
  it('succeed() keeps an operation as a value instead of running it', () => {
    let executed = 0
    const op = operation(function* () {
      executed++
      return 'ran'
    })

    const wrapped = succeed(op())

    // synchronous Success, not a Promise — and the operation was never started
    expect(isSuccess(wrapped)).toBe(true)
    expect(executed).toBe(0)
  })

  it('succeed() still unwraps a foreign promise', async () => {
    const wrapped = await (succeed(Promise.resolve(41)) as unknown as Promise<unknown>)

    expect(isSuccess(wrapped)).toBe(true)
    expect((wrapped as { value: number }).value).toBe(41)
  })

  it('attempt() reifies a stream-valued return that stays subscribable', async () => {
    const queue = createQueue<number, undefined>()
    queue.add(1)
    queue.add(2)
    queue.close(undefined)

    // the S6 shape: a handler answering with `lane()` — an Operation<Subscription> value
    const lane = operation(function* () {
      return queue
    })
    const handler = operation(function* () {
      return lane()
    })

    const drained = await run(function* () {
      const outcome = yield* attempt(() => handler())

      if (!isSuccess(outcome)) {
        return []
      }

      const sub = yield* outcome.value as unknown as Operation<{
        next(): Operation<IteratorResult<number, undefined>>
      }>
      const seen: number[] = []
      for (;;) {
        const step = yield* sub.next()
        if (step.done) {
          return seen
        }
        seen.push(step.value)
      }
    })

    expect(isSuccess(drained)).toBe(true)
    if (isSuccess(drained)) {
      expect(drained.value).toEqual([1, 2])
    }
  })
})
