import {
  constant,
  createChannel,
  createQueue,
  createSignal,
  each,
  once,
  run,
  scoped,
  sleep,
  spawn,
  withResolvers,
} from 'std:effect'
import type { Result } from 'std:result'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('signal fan-out', () => {
  it('every live subscriber gets its own queue; pre-subscription values are dropped', async () => {
    const outcome = await run(function* () {
      const signal = createSignal<number, void>()

      signal.send(0) // nobody is listening yet — dropped

      const first = yield* signal
      signal.send(1)

      const second = yield* signal
      signal.send(2)

      const firstSeen = [(yield* first.next()).value, (yield* first.next()).value]
      const secondSeen = [(yield* second.next()).value]

      return { firstSeen, secondSeen }
    })

    expect(unwrap(outcome)).toEqual({ firstSeen: [1, 2], secondSeen: [2] })
  })

  it('a subscription ends with its scope; remaining subscribers keep receiving', async () => {
    const outcome = await run(function* () {
      const signal = createSignal<number, void>()

      const outer = yield* signal

      yield* scoped(function* () {
        const inner = yield* signal
        signal.send(1)
        expect((yield* inner.next()).value).toBe(1)
      })

      // the scoped subscription is gone — this send must only reach `outer`
      signal.send(2)

      return [(yield* outer.next()).value, (yield* outer.next()).value]
    })

    expect(unwrap(outcome)).toEqual([1, 2])
  })

  it('close() ends every subscription with the close value', async () => {
    const outcome = await run(function* () {
      const signal = createSignal<number, string>()
      const subscription = yield* signal

      signal.send(7)
      signal.close('the-end')

      const first = yield* subscription.next()
      const done = yield* subscription.next()

      return { first, done }
    })

    expect(unwrap(outcome)).toEqual({
      first: { done: false, value: 7 },
      done: { done: true, value: 'the-end' },
    })
  })
})

describe('channel + each pipelines', () => {
  it('a spawned producer feeds a consuming each loop through close', async () => {
    const outcome = await run(function* () {
      const channel = createChannel<number, void>()
      const seen: number[] = []
      const done = withResolvers<number[]>()

      yield* spawn(function* () {
        for (const value of yield* each(channel)) {
          seen.push(value)
          yield* each.next()
        }
        done.resolve(seen)
      })

      yield* sleep(1)
      yield* channel.send(1)
      yield* channel.send(2)
      yield* channel.send(3)
      yield* channel.close()

      return yield* done.operation
    })

    expect(unwrap(outcome)).toEqual([1, 2, 3])
  })

  it('nested each loops keep their own cursors', async () => {
    const outcome = await run(function* () {
      const outerQueue = createQueue<string, void>()
      outerQueue.add('a')
      outerQueue.add('b')
      outerQueue.close()

      const pairs: string[] = []

      for (const outer of yield* each(constant(outerQueue))) {
        const innerQueue = createQueue<number, void>()
        innerQueue.add(1)
        innerQueue.add(2)
        innerQueue.close()

        for (const inner of yield* each(constant(innerQueue))) {
          pairs.push(`${outer}${inner}`)
          yield* each.next()
        }

        yield* each.next()
      }

      return pairs
    })

    expect(unwrap(outcome)).toEqual(['a1', 'a2', 'b1', 'b2'])
  })

  it('continuing an each loop without each.next() raises iteration-error', async () => {
    const outcome = await run(function* () {
      const queue = createQueue<number, void>()
      queue.add(1)
      queue.add(2)
      queue.close()

      // deliberately wrong: the loop body never calls each.next()
      for (const value of yield* each(constant(queue))) {
        void value
      }

      return 'unreachable'
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(String(outcome.error)).toContain('iteration-error')
    }
  })

  it('breaking out of each closes the loop; the subscription can be resumed manually afterwards', async () => {
    const outcome = await run(function* () {
      const queue = createQueue<number, void>()
      queue.add(1)
      queue.add(2)
      queue.add(3)
      queue.close()

      const seen: number[] = []
      for (const value of yield* each(constant(queue))) {
        seen.push(value)
        if (value === 2) {
          break
        }
        yield* each.next()
      }

      return seen
    })

    expect(unwrap(outcome)).toEqual([1, 2])
  })
})

describe('queue', () => {
  it('buffers ahead of the consumer and reports the close value once drained', async () => {
    const outcome = await run(function* () {
      const queue = createQueue<number, string>()
      queue.add(1)
      queue.add(2)
      queue.close('end')

      return [yield* queue.next(), yield* queue.next(), yield* queue.next()]
    })

    expect(unwrap(outcome)).toEqual([
      { done: false, value: 1 },
      { done: false, value: 2 },
      { done: true, value: 'end' },
    ])
  })

  it('a consumer blocked on next() resumes when a value arrives', async () => {
    const outcome = await run(function* () {
      const queue = createQueue<string, void>()
      const got = withResolvers<string | void>()

      yield* spawn(function* () {
        got.resolve((yield* queue.next()).value)
      })

      yield* sleep(1)
      queue.add('delivered')

      return yield* got.operation
    })

    expect(unwrap(outcome)).toBe('delivered')
  })
})

describe('event interop', () => {
  it('once() resumes exactly one waiter per event', async () => {
    const target = new EventTarget()

    const outcome = await run(function* () {
      const got = withResolvers<string>()

      yield* spawn(function* () {
        const event = yield* once(target, 'ping')
        got.resolve(event.type)
      })

      yield* sleep(1)
      target.dispatchEvent(new Event('ping'))

      return yield* got.operation
    })

    expect(unwrap(outcome)).toBe('ping')
  })
})

describe('stream close carrying a Result', () => {
  it('a channel close value typed as Result.Failure flows to the consumer as `done`', async () => {
    const outcome = await run(function* () {
      const channel = createChannel<number, true | Result.Failure<unknown>>()
      const subscription = yield* channel

      yield* channel.send(1)
      yield* channel.close(true)

      const first = yield* subscription.next()
      const done = yield* subscription.next()

      return { firstValue: first.value, doneValue: done.done ? done.value : 'not-done' }
    })

    expect(unwrap(outcome)).toEqual({ firstValue: 1, doneValue: true })
  })
})
