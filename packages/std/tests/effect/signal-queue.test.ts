import { createSignal, run, scoped, sleep } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * `SignalQueueFactoryContext` (internal/contexts.ts) decides which queue backs each
 * signal subscription, but it is internal and unexported — no scope can override it, so the
 * buffering strategy is fixed to `createQueue`. What CAN be pinned is the observable default:
 * values sent while nobody is subscribed are dropped, and once a subscriber exists its queue
 * buffers every value until it is pulled — per subscriber, and only for the subscription's
 * lifetime.
 */
describe('signal default queue', () => {
  it('drops values sent before anyone subscribes', async () => {
    const outcome = await run(function* () {
      const signal = createSignal<number, void>()

      signal.send(1)
      signal.send(2)

      const subscription = yield* signal
      signal.send(3)
      signal.close()

      const seen: number[] = []
      for (;;) {
        const next = yield* subscription.next()
        if (next.done) {
          break
        }
        seen.push(next.value)
      }
      return seen
    })

    expect(unwrap(outcome)).toEqual([3])
  })

  it('buffers values sent after subscribing until the subscriber pulls them (in order)', async () => {
    const outcome = await run(function* () {
      const signal = createSignal<number, void>()
      const subscription = yield* signal

      signal.send(1)
      signal.send(2)
      signal.send(3)

      // nothing was pulled yet — the queue holds all three
      yield* sleep(1)

      const first = yield* subscription.next()
      const second = yield* subscription.next()
      const third = yield* subscription.next()

      return [first, second, third].map(item => (item.done ? 'done' : item.value))
    })

    expect(unwrap(outcome)).toEqual([1, 2, 3])
  })

  it('a pending next() resumes with the next sent value', async () => {
    const outcome = await run(function* () {
      const signal = createSignal<string, void>()
      const subscription = yield* signal

      setTimeout(() => signal.send('late'), 5)

      const item = yield* subscription.next()

      return item.done ? 'done' : item.value
    })

    expect(unwrap(outcome)).toBe('late')
  })

  it('every subscriber gets its own queue with every value', async () => {
    const outcome = await run(function* () {
      const signal = createSignal<number, void>()
      const a = yield* signal
      const b = yield* signal

      signal.send(1)
      signal.send(2)

      // draining A must not consume B's copies
      const a1 = yield* a.next()
      const a2 = yield* a.next()
      const b1 = yield* b.next()
      const b2 = yield* b.next()

      return [a1, a2, b1, b2].map(item => (item.done ? 'done' : item.value))
    })

    expect(unwrap(outcome)).toEqual([1, 2, 1, 2])
  })

  it('close() ends every subscriber with the close value, after the buffered values', async () => {
    const outcome = await run(function* () {
      const signal = createSignal<number, string>()
      const subscription = yield* signal

      signal.send(1)
      signal.close('bye')

      const first = yield* subscription.next()
      const second = yield* subscription.next()

      return { first, second }
    })

    expect(unwrap(outcome)).toEqual({
      first: { done: false, value: 1 },
      second: { done: true, value: 'bye' },
    })
  })

  it('a subscription is scope-bound: values sent after its scope ended are dropped again', async () => {
    const outcome = await run(function* () {
      const signal = createSignal<number, void>()

      const insideScope = yield* scoped(function* () {
        const subscription = yield* signal
        signal.send(1)
        const item = yield* subscription.next()
        return item.done ? 'done' : item.value
      })

      // the only subscriber is gone: this send reaches nobody
      signal.send(2)

      const fresh = yield* signal
      signal.send(3)
      const item = yield* fresh.next()

      return { insideScope, afterwards: item.done ? 'done' : item.value }
    })

    expect(unwrap(outcome)).toEqual({ insideScope: 1, afterwards: 3 })
  })
})
