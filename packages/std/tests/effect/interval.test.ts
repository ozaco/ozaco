import { each, interval, run, scoped, sleep } from 'std:effect'
import { unwrap } from 'std:result'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

/**
 * `interval` (utils/interval.ts) is a `resource` around
 * `setInterval` feeding a signal: ticks are emitted on schedule (and buffered per subscriber
 * while nobody pulls), and the timer is cleared the moment the subscribing scope ends. The
 * clearing is pinned by wrapping the timer globals — `interval` looks them up at call time.
 */

const realSetInterval = globalThis.setInterval
const realClearInterval = globalThis.clearInterval

let created: unknown[] = []
let cleared: unknown[] = []

beforeEach(() => {
  created = []
  cleared = []
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const id = realSetInterval(...args)
    created.push(id)
    return id
  }) as typeof setInterval
  globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
    cleared.push(id)
    return realClearInterval(id)
  }) as typeof clearInterval
})

afterEach(() => {
  globalThis.setInterval = realSetInterval
  globalThis.clearInterval = realClearInterval
})

describe('interval', () => {
  it('emits on schedule: three ticks of 10ms take at least ~25ms', async () => {
    const started = performance.now()

    const outcome = await run(function* () {
      const ticks: number[] = []

      for (const _ of yield* each(interval(10))) {
        ticks.push(performance.now() - started)
        if (ticks.length === 3) {
          break
        }
        yield* each.next()
      }

      return ticks
    })

    const ticks = unwrap(outcome)

    expect(ticks).toHaveLength(3)
    // timers may fire slightly early on some platforms — allow ~15% slack on the total
    expect(ticks[2]!).toBeGreaterThanOrEqual(25)
    expect(ticks[0]! <= ticks[1]! && ticks[1]! <= ticks[2]!).toBe(true)
  })

  it('buffers ticks fired while the subscriber was busy', async () => {
    const outcome = await run(function* () {
      const subscription = yield* interval(5)

      // ~4 ticks fire while we are not pulling; they must queue up, not be lost
      yield* sleep(22)

      let buffered = 0
      const pulled = performance.now()

      // the buffered ticks are delivered immediately, without waiting for the timer
      while (performance.now() - pulled < 2) {
        yield* subscription.next()
        buffered++
        if (buffered >= 3) {
          break
        }
      }

      return buffered
    })

    expect(unwrap(outcome)).toBe(3)
  })

  it('clears its timer when the subscribing scope ends', async () => {
    await run(function* () {
      yield* scoped(function* () {
        const subscription = yield* interval(5)
        yield* subscription.next()

        expect(created).toHaveLength(1)
        expect(cleared).toHaveLength(0)
      })

      // the scope ended: the interval resource tore down synchronously with it
      expect(cleared).toEqual(created)
    })
  })

  it('clears its timer when the consuming task finishes', async () => {
    await run(function* () {
      for (const _ of yield* each(interval(5))) {
        break
      }
    })

    expect(created).toHaveLength(1)
    expect(cleared).toEqual(created)
  })

  it('each subscription owns its own timer', async () => {
    await run(function* () {
      const flow = interval(5)

      yield* scoped(function* () {
        const a = yield* flow
        const b = yield* flow

        yield* a.next()
        yield* b.next()

        expect(created).toHaveLength(2)
      })
    })

    expect(cleared.length).toBe(2)
    expect(new Set(cleared)).toEqual(new Set(created))
  })
})
