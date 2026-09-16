/**
 * `emitAsync` awaits any thenable a listener returns (through `isPromise`), the emitter tag is a
 * public constant, and the effect bridges are generator operations and a Flow.
 */
import { run, sleep, spawn } from 'std:effect'
import {
  createEvent,
  EVENT,
  isEventEmitter,
  onEvent,
  useBufferedEvent,
  useEventOnce,
} from 'std:event'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

describe('event — contract', () => {
  it('emitAsync awaits a thenable that is not a Promise instance', async () => {
    const emitter = createEvent<{ tick: [n: number] }>()
    const seen: string[] = []

    // a bare thenable: `isPromise` sees it, `instanceof Promise` would not
    const thenable = {
      // oxlint-disable-next-line unicorn/no-thenable -- the point of the test
      then: (resolve: (value: void) => void) => {
        setTimeout(() => {
          seen.push('thenable')
          resolve()
        }, 5)
      },
    } as unknown as Promise<void>
    emitter.on('tick', () => thenable)
    emitter.on('tick', () => {
      seen.push('sync')
    })

    await emitter.emitAsync('tick', 1)
    expect(seen.toSorted()).toEqual(['sync', 'thenable'])
  })

  it('the emitter tag is the exported EVENT symbol', () => {
    const emitter = createEvent<{ a: [] }>()
    expect(emitter._t).toBe(EVENT)
    expect(isEventEmitter({ _t: EVENT })).toBe(true)
    expect(EVENT).toBe(Symbol.for('std:event') as typeof EVENT)
  })

  it('the bridges are generator operations and a Flow, usable with yield* directly', async () => {
    const emitter = createEvent<{ value: [n: number] }>()

    unwrap(
      await run(function* () {
        const once = yield* spawn(() => useEventOnce(emitter, 'value'))
        yield* sleep(1)
        emitter.emit('value', 7)
        expect(yield* once).toEqual([7])

        const seen: number[] = []
        const listening = yield* spawn(() =>
          onEvent(emitter, 'value', function* (n) {
            seen.push(n)
          }),
        )
        yield* sleep(1)
        emitter.emit('value', 1)
        emitter.emit('value', 2)
        yield* sleep(1)
        yield* listening.halt()
        expect(seen).toEqual([1, 2])

        // buffered: events emitted before next() is called are kept
        const buffered = yield* useBufferedEvent(emitter, 'value')
        emitter.emit('value', 3)
        emitter.emit('value', 4)
        expect((yield* buffered.next()).value).toEqual([3])
        expect((yield* buffered.next()).value).toEqual([4])
      }),
    )
  })
})
