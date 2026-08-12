import { each, run, scoped, sleep, spawn, withResolvers } from 'std:effect'
import { createEvent, onEvent, useBufferedEvent, useEvent, useEventOnce } from 'std:event'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('useEvent', () => {
  it('delivers post-subscription events in order, as argument tuples', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        const emitter = createEvent<{ msg: [string, number] }>()
        const subscription = yield* useEvent(emitter, 'msg')

        emitter.emit('msg', 'a', 1)
        emitter.emit('msg', 'b', 2)

        return [(yield* subscription.next()).value, (yield* subscription.next()).value]
      }),
    )

    expect(unwrap(outcome)).toEqual([
      ['a', 1],
      ['b', 2],
    ])
  })

  it('drops events emitted before the subscription exists', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        const emitter = createEvent<{ ping: [string] }>()
        emitter.emit('ping', 'early')

        const subscription = yield* useEvent(emitter, 'ping')
        emitter.emit('ping', 'late')

        return (yield* subscription.next()).value
      }),
    )

    expect(unwrap(outcome)).toEqual(['late'])
  })

  it('attaches its listener on subscribe and detaches it when the scope closes', async () => {
    const emitter = createEvent<{ ping: [] }>()

    const outcome = await run(function* () {
      const before = emitter.listenerCount('ping')

      const during = yield* scoped(function* () {
        yield* useEvent(emitter, 'ping')
        return emitter.listenerCount('ping')
      })

      return { before, during, after: emitter.listenerCount('ping') }
    })

    expect(unwrap(outcome)).toEqual({ before: 0, during: 1, after: 0 })
  })

  it('a consumer blocked on next() resumes when the event fires', async () => {
    const outcome = await run(function* () {
      const emitter = createEvent<{ ready: [number] }>()
      const got = withResolvers<number>()

      yield* spawn(function* () {
        const subscription = yield* useEvent(emitter, 'ready')
        const [n] = (yield* subscription.next()).value
        got.resolve(n)
      })

      yield* sleep(1)
      emitter.emit('ready', 99)

      return yield* got.operation
    })

    expect(unwrap(outcome)).toBe(99)
  })

  it('feeds each() loops; breaking out ends consumption and teardown still runs', async () => {
    const emitter = createEvent<{ tick: [number] }>()

    const outcome = await run(function* () {
      const seen: number[] = []

      yield* scoped(function* () {
        const finished = withResolvers<void>()

        yield* spawn(function* () {
          for (const [n] of yield* each(useEvent(emitter, 'tick'))) {
            seen.push(n)
            if (n === 3) {
              break
            }
            yield* each.next()
          }
          finished.resolve()
        })

        yield* sleep(1)
        emitter.emit('tick', 1)
        emitter.emit('tick', 2)
        emitter.emit('tick', 3)
        emitter.emit('tick', 4) // queued after the break point — never observed

        yield* finished.operation
      })

      return { seen, count: emitter.listenerCount('tick') }
    })

    expect(unwrap(outcome)).toEqual({ seen: [1, 2, 3], count: 0 })
  })
})

describe('useEventOnce', () => {
  it('resolves with the first payload and holds its listener until the scope ends', async () => {
    const emitter = createEvent<{ ping: [string] }>()

    const outcome = await run(function* () {
      const inside = yield* scoped(function* () {
        yield* spawn(function* () {
          yield* sleep(1)
          emitter.emit('ping', 'hello')
        })

        const args = yield* useEventOnce(emitter, 'ping')

        // the underlying resource lives with the enclosing scope, not with the completed wait
        return { args, count: emitter.listenerCount('ping') }
      })

      return { ...inside, after: emitter.listenerCount('ping') }
    })

    expect(unwrap(outcome)).toEqual({ args: ['hello'], count: 1, after: 0 })
  })

  it('sequential waits observe successive events', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        const emitter = createEvent<{ step: [number] }>()

        yield* spawn(function* () {
          yield* sleep(1)
          emitter.emit('step', 1)
          yield* sleep(1)
          emitter.emit('step', 2)
        })

        const first = yield* useEventOnce(emitter, 'step')
        const second = yield* useEventOnce(emitter, 'step')

        return [first[0], second[0]]
      }),
    )

    expect(unwrap(outcome)).toEqual([1, 2])
  })
})

describe('onEvent', () => {
  it('runs the handler operation per event and detaches when its scope halts', async () => {
    const emitter = createEvent<{ log: [string] }>()
    const seen: string[] = []

    const outcome = await run(function* () {
      yield* scoped(function* () {
        yield* spawn(() =>
          onEvent(emitter, 'log', function* (text) {
            seen.push(text)
          }),
        )

        yield* sleep(1)
        emitter.emit('log', 'a')
        emitter.emit('log', 'b')
        yield* sleep(1)
      })

      emitter.emit('log', 'after-scope') // the loop is gone — must reach nobody
      return emitter.listenerCount('log')
    })

    expect(unwrap(outcome)).toBe(0)
    expect(seen).toEqual(['a', 'b'])
  })
})

describe('useBufferedEvent', () => {
  it('buffers events emitted before the consumer pulls', async () => {
    const outcome = await run(() =>
      scoped(function* () {
        const emitter = createEvent<{ data: [number] }>()
        const subscription = yield* useBufferedEvent(emitter, 'data')

        emitter.emit('data', 1)
        emitter.emit('data', 2)
        emitter.emit('data', 3)

        return [
          (yield* subscription.next()).value,
          (yield* subscription.next()).value,
          (yield* subscription.next()).value,
        ]
      }),
    )

    expect(unwrap(outcome)).toEqual([[1], [2], [3]])
  })

  it('ignores pre-subscription events and detaches when the scope closes', async () => {
    const emitter = createEvent<{ data: [string] }>()
    emitter.emit('data', 'early')

    const outcome = await run(function* () {
      const during = yield* scoped(function* () {
        const subscription = yield* useBufferedEvent(emitter, 'data')
        emitter.emit('data', 'late')

        const first = yield* subscription.next()
        return { count: emitter.listenerCount('data'), first: first.value }
      })

      return { ...during, after: emitter.listenerCount('data') }
    })

    expect(unwrap(outcome)).toEqual({ count: 1, first: ['late'], after: 0 })
  })
})
