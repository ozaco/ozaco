import { createFuture, run, sleep, spawn, suspend } from 'std:effect'
import { fail, isFailure, isSuccess } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * AUDIT E5: the "promise side never rejects" contract (`types/operation.ts`) is pinned only for
 * `Task.promise` (tests/effect/task-promise.test.ts). This file pins the OTHER promise-side
 * surfaces — `task.halt()`, `task[Symbol.asyncDispose]()` and `createFuture().reject()` — exactly
 * as they behave TODAY.
 *
 * DEVIATION PINNED (AUDIT E1/E2): two of these paths currently REJECT, contradicting the
 * documented contract:
 *   - E2: `halt()` (and `Symbol.asyncDispose`, which inherits it) rejects when the halted task's
 *     unwind settles a failure (a failing `finally`/teardown). `utils/to-future.ts` works around it
 *     with `.catch(() => {})`.
 *   - E1: `createFuture().reject()` calls `promise.reject`, so the returned `Future` rejects — and
 *     the rejection value is the Failure's bare `error` field (the lazy promise unwraps it), so the
 *     message and causes are lost on the promise side.
 * The `it('DEVIATION …')` cases below assert the rejection on purpose: when E1/E2 are fixed they
 * will FAIL, which is the signal to flip them to the "resolves a Failure" expectation.
 */
describe('halt() promise side', () => {
  it('resolves undefined for a task that is still running', async () => {
    const task = run(function* () {
      yield* suspend()
    })

    let rejected = false

    const halted = await task.halt().catch(() => {
      rejected = true
    })

    expect(rejected).toBe(false)
    expect(halted).toBeUndefined()

    const outcome = await task
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('std:effect.halted')
    }
  })

  it('resolves undefined for a task that already failed on its own', async () => {
    // interrupting a settled task is a no-op: nothing was interrupted, so the settled failure is
    // NOT re-raised through halt() — the failure stays where it belongs, on the task promise
    const task = run(function* () {
      return yield* fail('already.failed')
    })

    const outcome = await task
    expect(isFailure(outcome)).toBe(true)

    let rejected = false
    const halted = await task.halt().catch(() => {
      rejected = true
    })

    expect(rejected).toBe(false)
    expect(halted).toBeUndefined()

    const disposed = await task[Symbol.asyncDispose]().catch(() => 'rejected')
    expect(disposed).toBeUndefined()
  })

  it('DEVIATION (E2): rejects when the halted task fails while unwinding', async () => {
    const task = run(function* () {
      try {
        yield* suspend()
      } finally {
        yield* fail('teardown.boom', 'raised during unwind')
      }
    })

    let rejection: unknown

    try {
      await task.halt()
      rejection = 'resolved'
    } catch (error) {
      rejection = error
    }

    // the failure escapes as a rejection — the contract says it should resolve a Failure
    expect(rejection).not.toBe('resolved')
    expect(isFailure(rejection)).toBe(true)
    if (isFailure(rejection)) {
      expect(rejection.error).toBe('teardown.boom')
    }

    // the task promise itself honors the contract: it resolves the same Failure
    const outcome = await task
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('teardown.boom')
    }
  })

  it('DEVIATION (E2): Symbol.asyncDispose inherits the rejection', async () => {
    const task = run(function* () {
      try {
        yield* suspend()
      } finally {
        yield* fail('dispose.boom')
      }
    })

    let rejection: unknown

    try {
      await task[Symbol.asyncDispose]()
      rejection = 'resolved'
    } catch (error) {
      rejection = error
    }

    expect(rejection).not.toBe('resolved')
    expect(isFailure(rejection)).toBe(true)
    if (isFailure(rejection)) {
      expect(rejection.error).toBe('dispose.boom')
    }
  })

  it('the operation side of halt() raises the unwind failure (unchanged, in-effect)', async () => {
    const outcome = await run(function* () {
      const task = yield* spawn(function* () {
        try {
          yield* suspend()
        } finally {
          yield* fail('child.teardown.boom')
        }
      })

      yield* sleep(1)

      let raised: unknown

      try {
        yield* task.halt()
      } catch (error) {
        raised = error
      }

      return isFailure(raised) ? String(raised.error) : 'no-raise'
    })

    expect(isSuccess(outcome)).toBe(true)
    if (isSuccess(outcome)) {
      expect(outcome.value).toBe('child.teardown.boom')
    }
  })
})

describe('createFuture() promise side', () => {
  it('resolve() settles the promise side with Success<T> and the operation side with T', async () => {
    const { future, resolve } = createFuture<number>()

    resolve(7)

    const settled = await future
    expect(isSuccess(settled)).toBe(true)
    if (isSuccess(settled)) {
      expect(settled.value).toBe(7)
    }

    const viaOperation = await run(function* () {
      return yield* future
    })
    expect(isSuccess(viaOperation)).toBe(true)
    if (isSuccess(viaOperation)) {
      expect(viaOperation.value).toBe(7)
    }
  })

  it('DEVIATION (E1): reject() makes the Future REJECT instead of resolving the Failure', async () => {
    const { future, reject } = createFuture<number>()

    reject(fail('future.rejected', 'through promise.reject'))

    let rejection: unknown

    try {
      await future
      rejection = 'resolved'
    } catch (error) {
      rejection = error
    }

    expect(rejection).not.toBe('resolved')
    // the promise rejects with the Failure's `error` field, NOT the Failure itself
    expect(isFailure(rejection)).toBe(false)
    expect(rejection).toBe('future.rejected')
  })

  it('reject() raises the Failure on the operation side (in-effect, as documented)', async () => {
    const { future, reject } = createFuture<number>()

    reject(fail('future.rejected'))

    // keep the promise side observed so the deviation above cannot surface as an unhandled
    // rejection while we exercise the operation side
    future.catch(() => {})

    const outcome = await run(function* () {
      let raised: unknown

      try {
        yield* future
      } catch (error) {
        raised = error
      }

      return isFailure(raised) ? String(raised.error) : 'no-raise'
    })

    expect(isSuccess(outcome)).toBe(true)
    if (isSuccess(outcome)) {
      expect(outcome.value).toBe('future.rejected')
    }
  })
})
