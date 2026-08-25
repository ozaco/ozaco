import type { Flow, Queue } from 'std:effect'
import { createQueue, each, run } from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/** A pre-buffered single-consumer flow over a queue (the queueFlow pattern from io/internal). */
const queueFlow = <T, TClose>(queue: Queue<T, TClose>): Flow<T, TClose> => ({
  *[Symbol.iterator]() {
    return queue
  },
})

describe('each honors the flow close value', () => {
  it('a Failure close raises out of the loop after the buffered values are delivered', async () => {
    const seen: number[] = []

    const outcome = await run(function* () {
      const queue = createQueue<number, unknown>()
      queue.add(1)
      queue.add(2)
      queue.close(fail('truncated', 'source died mid-flow'))

      for (const value of yield* each(queueFlow(queue))) {
        seen.push(value)
        yield* each.next()
      }

      return 'completed'
    })

    expect(seen).toEqual([1, 2])
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(String(outcome.error)).toBe('truncated')
    }
  })

  it('an immediately failing flow raises before the body ever runs', async () => {
    let bodyRan = false

    const outcome = await run(function* () {
      const queue = createQueue<number, unknown>()
      queue.close(fail('never-opened'))

      for (const _ of yield* each(queueFlow(queue))) {
        bodyRan = true
        yield* each.next()
      }

      return 'completed'
    })

    expect(bodyRan).toBe(false)
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(String(outcome.error)).toBe('never-opened')
    }
  })

  it('a non-failure close value still ends the loop cleanly', async () => {
    const outcome = await run(function* () {
      const queue = createQueue<number, string>()
      queue.add(7)
      queue.close('done-marker')

      const seen: number[] = []
      for (const value of yield* each(queueFlow(queue))) {
        seen.push(value)
        yield* each.next()
      }

      return seen
    })

    expect(unwrap(outcome)).toEqual([7])
  })

  it('yield*-ing a failure inside the body is break-with-failure — no dedicated api needed', async () => {
    const seen: number[] = []

    const outcome = await run(function* () {
      const queue = createQueue<number, never>()
      queue.add(1)
      queue.add(2)

      for (const value of yield* each(queueFlow(queue))) {
        seen.push(value)
        // the consumer decides to abort: raising a failure exits the loop (for-of teardown runs)
        // and settles the surrounding operation with it
        yield* fail('consumer-abort', 'stopping early')
        yield* each.next()
      }

      return 'completed'
    })

    expect(seen).toEqual([1])
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(String(outcome.error)).toBe('consumer-abort')
    }
  })
})
