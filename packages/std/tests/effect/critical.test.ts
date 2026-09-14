import { critical, run, sleep, useScope } from 'std:effect'
import { unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * AUDIT E44: `critical` (base/coroutine.ts) marks a region whose `unwind()` (halt) is deferred:
 * the region runs to completion and the unwind takes effect at the next suspension point after
 * it. Scope teardown depends on this — `createTask` and `scoped` wrap `destroy` in `critical` —
 * yet it had no direct test. Pinned: the region completes, sync code right after the region still
 * runs (the unwind only fires at a yield), nothing past the next suspension point runs, and the
 * enclosing `finally` still runs.
 */
describe('critical', () => {
  it('baseline: a halt mid-sleep skips the rest of a NON-critical region', async () => {
    const order: string[] = []

    await run(function* () {
      const scope = yield* useScope()

      const task = scope.run(function* () {
        try {
          order.push('start')
          yield* sleep(20)
          order.push('end')
        } finally {
          order.push('finally')
        }
      })

      yield* sleep(1)
      yield* task.halt()
    })

    expect(order).toEqual(['start', 'finally'])
  })

  it('defers a halt until the critical region has run to completion', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      const scope = yield* useScope()

      const task = scope.run(function* () {
        try {
          const value = yield* critical(function* () {
            order.push('critical-start')
            yield* sleep(20)
            order.push('critical-end')
            return 'critical-value'
          })

          // the unwind only fires at a suspension point: this sync tail still runs
          order.push(`after-critical:${value}`)
          yield* sleep(1)
          order.push('after-suspend')
        } finally {
          order.push('finally')
        }
      })

      yield* sleep(1)
      order.push('halting')
      yield* task.halt()
      order.push('halted')

      return order.slice()
    })

    expect(unwrap(outcome)).toEqual(order)
    expect(order).toEqual([
      'critical-start',
      'halting',
      'critical-end',
      'after-critical:critical-value',
      'finally',
      'halted',
    ])
  })

  it('restores the previous critical flag: a halt during the SECOND region is deferred again, and between regions it is not', async () => {
    const order: string[] = []

    await run(function* () {
      const scope = yield* useScope()

      const task = scope.run(function* () {
        try {
          yield* critical(function* () {
            order.push('first-start')
            yield* sleep(5)
            order.push('first-end')
          })

          yield* sleep(5)
          order.push('between')

          yield* critical(function* () {
            order.push('second-start')
            yield* sleep(20)
            order.push('second-end')
          })

          yield* sleep(1)
          order.push('unreachable')
        } finally {
          order.push('finally')
        }
      })

      // halt while inside the second region: the first region already restored critical=false,
      // so `between` ran normally, and the second region is again protected
      yield* sleep(15)
      yield* task.halt()
    })

    expect(order).toEqual([
      'first-start',
      'first-end',
      'between',
      'second-start',
      'second-end',
      'finally',
    ])
  })

  it('a halt between regions is NOT deferred (the flag was restored)', async () => {
    const order: string[] = []

    await run(function* () {
      const scope = yield* useScope()

      const task = scope.run(function* () {
        try {
          yield* critical(function* () {
            order.push('first')
          })

          yield* sleep(20)
          order.push('unreachable')
        } finally {
          order.push('finally')
        }
      })

      yield* sleep(1)
      yield* task.halt()
    })

    expect(order).toEqual(['first', 'finally'])
  })

  it('returns the region value when not halted at all', async () => {
    const outcome = await run(function* () {
      return yield* critical(function* () {
        yield* sleep(1)
        return 'plain'
      })
    })

    expect(unwrap(outcome)).toBe('plain')
  })
})
