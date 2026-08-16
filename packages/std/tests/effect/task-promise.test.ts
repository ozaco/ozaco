import { box, createScope, run, sleep, spawn, suspend, useScope } from 'std:effect'
import { fail, isFailure, isSuccess, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * The Task promise contract (std): the promise side ALWAYS resolves a Result and NEVER rejects —
 * success resolves `Success<T>`, an operation failure resolves the `Failure` itself, and a halt
 * resolves `fail('halted')`. Supervision: `spawn`/`fork`/default `scope.run` failures ALSO crash
 * the owning scope (structured concurrency); `scope.run(op, { detached: true })` delivers the
 * failure through the future ONLY. These semantics were previously divergent (raw success values,
 * halt rejections, unconditional scope crashes) and broke real servers — pinned here for good.
 */
describe('task promise contract', () => {
  it('success resolves Success<T> (run and scope.run alike)', async () => {
    const outcome = await run(function* () {
      return 42
    })

    expect(isSuccess(outcome)).toBe(true)
    expect(unwrap(outcome)).toBe(42)

    await using scope = createScope()

    const viaScope = await scope.run(function* () {
      yield* sleep(1)

      return 'scoped'
    })

    expect(isSuccess(viaScope)).toBe(true)
    expect(unwrap(viaScope)).toBe('scoped')
  })

  it('an operation failure resolves the Failure itself — the promise never rejects', async () => {
    let rejected = false

    const outcome = await run(function* () {
      return yield* fail('task.boom', 'kaput')
    }).catch(() => {
      rejected = true

      return fail('should-not-happen')
    })

    expect(rejected).toBe(false)
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('task.boom')
      expect(outcome.message).toBe('kaput')
    }
  })

  it('halting resolves fail("halted") instead of rejecting', async () => {
    const task = run(function* () {
      yield* suspend()
    })

    let rejected = false

    const settled = task.catch(() => {
      rejected = true

      return fail('should-not-happen')
    })

    await task.halt()

    const outcome = await settled

    expect(rejected).toBe(false)
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('halted')
    }
  })

  it('a materialized failing task produces no unhandled rejection', async () => {
    // `.finally` materializes the promise without a rejection handler — under the old semantics
    // this was the tcpListen bug class (unhandled `halted`/failure rejections). A rejection here
    // would fail the bun test run.
    const task = run(function* () {
      return yield* fail('fire-and-forget')
    })

    void task.finally(() => {})

    const outcome = await task

    expect(isFailure(outcome)).toBe(true)
  })
})

describe('supervision', () => {
  it('spawn failures crash the owning scope (structured concurrency, unchanged)', async () => {
    const outcome = await run(function* () {
      yield* spawn(function* () {
        yield* sleep(1)

        return yield* fail('child.boom')
      })

      yield* sleep(50)

      return 'unreachable'
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('child.boom')
    }
  })

  it('detached scope.run failures settle the future ONLY — siblings and the scope survive', async () => {
    const outcome = await run(function* () {
      const scope = yield* useScope()

      const failing = scope.run(
        function* () {
          yield* sleep(1)

          return yield* fail('detached.boom', 'delivered via future only')
        },
        { detached: true },
      )

      // the distilled server repro: keep suspending AFTER the detached task failed — under the
      // old semantics the scope crashed here at the next suspension point
      yield* sleep(20)

      const delivered = yield* box(() => failing)

      return { alive: true, delivered }
    })

    expect(isSuccess(outcome)).toBe(true)
    if (isSuccess(outcome)) {
      expect(outcome.value.alive).toBe(true)
      expect(isFailure(outcome.value.delivered)).toBe(true)
      if (isFailure(outcome.value.delivered)) {
        expect(outcome.value.delivered.error).toBe('detached.boom')
      }
    }
  })

  it('a fire-and-forget detached failure does not kill unrelated work', async () => {
    const order: string[] = []

    const outcome = await run(function* () {
      const scope = yield* useScope()

      void scope.run(
        function* () {
          return yield* fail('background.boom')
        },
        { detached: true },
      )

      yield* spawn(function* () {
        yield* sleep(10)
        order.push('sibling-finished')
      })

      yield* sleep(30)
      order.push('root-finished')

      return order.slice()
    })

    expect(unwrap(outcome)).toEqual(['sibling-finished', 'root-finished'])
  })

  it('default (supervised) scope.run failures still crash the scope', async () => {
    const outcome = await run(function* () {
      const scope = yield* useScope()

      void scope.run(function* () {
        yield* sleep(1)

        return yield* fail('supervised.boom')
      })

      yield* sleep(50)

      return 'unreachable'
    })

    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('supervised.boom')
    }
  })

  it('yield* task still raises the failure in-effect (operation side unchanged)', async () => {
    const outcome = await run(function* () {
      const scope = yield* useScope()
      const task = scope.run(
        function* () {
          return yield* fail('raised.boom')
        },
        { detached: true },
      )

      let raised: unknown

      try {
        yield* task
      } catch (error) {
        raised = error
      }

      return isFailure(raised) ? String(raised.error) : 'no-raise'
    })

    expect(unwrap(outcome)).toBe('raised.boom')
  })
})
