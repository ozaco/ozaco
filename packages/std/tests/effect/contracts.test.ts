import { createFuture, run, sleep, spawn, suspend } from 'std:effect'
import { fail, isFailure, isSuccess } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * The "promise side never rejects" contract (`types/operation.ts`) on EVERY promise-side surface:
 * `Task.promise` (tests/effect/task-promise.test.ts), and here `task.halt()`,
 * `task[Symbol.asyncDispose]()` and `createFuture().reject()`. Each of them resolves a `Result`
 * — a Failure is a VALUE on the promise side and a raise on the operation side.
 */
describe('halt() promise side', () => {
  it('resolves a Success for a task that is still running', async () => {
    const task = run(function* () {
      yield* suspend()
    })

    let rejected = false

    const halted = await task.halt().catch(() => {
      rejected = true
    })

    expect(rejected).toBe(false)
    expect(isSuccess(halted)).toBe(true)

    const outcome = await task
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('std:effect.halted')
    }
  })

  it('resolves a Success for a task that already failed on its own', async () => {
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
    expect(isSuccess(halted)).toBe(true)

    const disposed = await task[Symbol.asyncDispose]().catch(() => 'rejected')
    expect(isSuccess(disposed)).toBe(true)
  })

  it('resolves the Failure when the halted task fails while unwinding', async () => {
    const task = run(function* () {
      try {
        yield* suspend()
      } finally {
        yield* fail('teardown.boom', 'raised during unwind')
      }
    })

    let rejected = false
    const halted = await task.halt().catch(() => {
      rejected = true
    })

    // the unwind failure is the RESOLVED value — never a rejection
    expect(rejected).toBe(false)
    expect(isFailure(halted)).toBe(true)
    if (isFailure(halted)) {
      expect(halted.error).toBe('teardown.boom')
      expect(halted.message).toBe('raised during unwind')
    }

    // the task promise itself honors the contract: it resolves the same Failure
    const outcome = await task
    expect(isFailure(outcome)).toBe(true)
    if (isFailure(outcome)) {
      expect(outcome.error).toBe('teardown.boom')
    }
  })

  it('Symbol.asyncDispose settles the same way: `await using` never throws on teardown', async () => {
    const task = run(function* () {
      try {
        yield* suspend()
      } finally {
        yield* fail('dispose.boom')
      }
    })

    let rejected = false
    const disposed = await task[Symbol.asyncDispose]().catch(() => {
      rejected = true
    })

    expect(rejected).toBe(false)
    expect(isFailure(disposed)).toBe(true)
    if (isFailure(disposed)) {
      expect(disposed.error).toBe('dispose.boom')
    }

    // the task promise itself resolves the same Failure
    const outcome = await task
    expect(isFailure(outcome) && outcome.error).toBe('dispose.boom')
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

  it('reject() resolves the promise side with the Failure itself — message and causes intact', async () => {
    const { future, reject } = createFuture<number>()

    reject(fail('future.rejected', 'through reject', 'probe:cause'))

    let rejected = false
    const settled = await future.catch(() => {
      rejected = true
    })

    expect(rejected).toBe(false)
    expect(isFailure(settled)).toBe(true)
    if (isFailure(settled)) {
      expect(settled.error).toBe('future.rejected')
      expect(settled.message).toBe('through reject')
      expect(settled.causes).toContain('probe:cause')
    }
  })

  it('reject() raises the Failure on the operation side (in-effect, as documented)', async () => {
    const { future, reject } = createFuture<number>()

    reject(fail('future.rejected'))

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
