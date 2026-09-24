import type { Operation } from 'std:effect'
import {
  attempt,
  createMutex,
  createSemaphore,
  run,
  sleep,
  spawn,
  suspend,
  withResolvers,
} from 'std:effect'
import { fail, isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

const tick = (ms = 5) =>
  new Promise<void>(resolve => {
    setTimeout(resolve, ms)
  })

describe('createMutex', () => {
  it('never overlaps bodies and admits waiters in FIFO order', async () => {
    const mutex = createMutex()
    const log: string[] = []

    const body = (name: string) =>
      function* (): Operation<void> {
        log.push(`${name}:in`)
        yield* sleep(3)
        log.push(`${name}:out`)
      }

    const outcome = await run(function* () {
      const tasks = []
      for (const name of ['a', 'b', 'c', 'd']) {
        tasks.push(yield* spawn(() => mutex.run(body(name))))
      }

      yield* sleep(1)
      const snapshot = { locked: mutex.locked(), waiting: mutex.waiting() }

      for (const task of tasks) {
        yield* task
      }

      return snapshot
    })

    expect(unwrap(outcome)).toEqual({ locked: true, waiting: 3 })
    expect(log).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out', 'd:in', 'd:out'])
    expect(mutex.locked()).toBe(false)
    expect(mutex.waiting()).toBe(0)
  })

  it('returns the body value and re-raises its failure, releasing the lock either way', async () => {
    const mutex = createMutex()

    const outcome = await run(function* () {
      const failed = yield* attempt(() =>
        mutex.run(function* () {
          return yield* fail('mutex-test.boom', 'body failed')
        }),
      )

      const value = yield* mutex.run(function* () {
        return 42
      })

      return { error: isFailure(failed) ? failed.error : null, value }
    })

    expect(unwrap(outcome)).toEqual({ error: 'mutex-test.boom', value: 42 })
    expect(mutex.locked()).toBe(false)
  })
})

describe('createSemaphore', () => {
  it('caps concurrency at n permits', async () => {
    const semaphore = createSemaphore(2)
    let active = 0
    let peak = 0

    function* body(): Operation<void> {
      active += 1
      peak = Math.max(peak, active)
      yield* sleep(3)
      active -= 1
    }

    await run(function* () {
      const tasks = []
      for (let index = 0; index < 6; index += 1) {
        tasks.push(yield* spawn(() => semaphore.run(body)))
      }

      yield* sleep(1)
      expect(semaphore.available()).toBe(0)
      expect(semaphore.waiting()).toBe(4)

      for (const task of tasks) {
        yield* task
      }
    })

    expect(peak).toBe(2)
    expect(semaphore.available()).toBe(2)
    expect(semaphore.waiting()).toBe(0)
  })

  it('releases the permit when the holder is halted', async () => {
    const semaphore = createSemaphore(1)
    let cleaned = false

    const holder = run(() =>
      semaphore.run(function* () {
        try {
          yield* suspend()
        } finally {
          cleaned = true
        }
      }),
    )

    const waiter = run(() =>
      semaphore.run(function* () {
        return 'got it'
      }),
    )

    await tick()
    expect(semaphore.waiting()).toBe(1)

    await holder.halt()
    expect(cleaned).toBe(true)
    expect(unwrap(await waiter)).toBe('got it')
    expect(semaphore.available()).toBe(1)
  })

  it('a waiter halted while parked leaves the queue without leaking a permit', async () => {
    const semaphore = createSemaphore(1)
    const gate = withResolvers<void>()
    let ranHalted = false

    const holder = run(() => semaphore.run(() => gate.operation))
    const halted = run(() =>
      semaphore.run(function* () {
        ranHalted = true
      }),
    )
    const last = run(() =>
      semaphore.run(function* () {
        return 'last'
      }),
    )

    await tick()
    expect(semaphore.waiting()).toBe(2)

    await halted.halt()
    expect(semaphore.waiting()).toBe(1)

    gate.resolve()
    await holder
    expect(unwrap(await last)).toBe('last')
    expect(ranHalted).toBe(false)
    expect(semaphore.available()).toBe(1)
    expect(semaphore.waiting()).toBe(0)
  })

  it('a waiter halted right as the permit is handed to it passes the permit on', async () => {
    const semaphore = createSemaphore(1)
    const gate = withResolvers<void>()

    const holder = run(() => semaphore.run(() => gate.operation))
    const granted = run(() =>
      semaphore.run(function* () {
        yield* suspend()
      }),
    )
    const last = run(() =>
      semaphore.run(function* () {
        return 'last'
      }),
    )

    await tick()

    // hand the permit over and halt its new owner in the same synchronous turn
    gate.resolve()
    // halt() is a lazy Future — `then` is what interrupts, so start it now
    const halting = granted.halt().then(outcome => outcome)

    await holder
    await halting
    expect(unwrap(await last)).toBe('last')
    expect(semaphore.available()).toBe(1)
    expect(semaphore.waiting()).toBe(0)
  })
})
