import {
  attempt,
  EffectErrors,
  run,
  scoped,
  sleep,
  suspend,
  useAbortSignal,
  useScope,
  using,
} from 'std:effect'
import { isFailure, unwrap } from 'std:result'

import { describe, expect, it } from 'bun:test'

/**
 * AUDIT E43: neither `using` (utils/using.ts) nor `useAbortSignal` (utils/abort-signal.ts) was
 * exercised by any effect test. Both are thin `resource`s: `using` adopts a JS disposable and
 * disposes it when the scope ends (asyncDispose preferred, awaited), failing
 * `EffectErrors.Using` for a value that is neither; `useAbortSignal` hands out an AbortSignal that
 * aborts when the scope ends.
 */
describe('using', () => {
  it('returns the value itself and calls Symbol.dispose when the scope ends', async () => {
    const order: string[] = []
    const disposable = {
      name: 'sync',
      [Symbol.dispose]() {
        order.push('dispose')
      },
    }

    const outcome = await run(function* () {
      const adopted = yield* scoped(function* () {
        const value = yield* using(disposable)
        order.push('acquired')
        yield* sleep(1)
        order.push('leaving')
        return value
      })

      order.push('after-scope')

      return adopted === disposable
    })

    expect(unwrap(outcome)).toBe(true)
    expect(order).toEqual(['acquired', 'leaving', 'dispose', 'after-scope'])
  })

  it('awaits Symbol.asyncDispose before the scope finishes', async () => {
    const order: string[] = []
    const disposable = {
      async [Symbol.asyncDispose]() {
        order.push('dispose-start')
        await Bun.sleep(10)
        order.push('dispose-end')
      },
    }

    await run(function* () {
      yield* scoped(function* () {
        yield* using(disposable)
        order.push('acquired')
      })

      order.push('after-scope')
    })

    expect(order).toEqual(['acquired', 'dispose-start', 'dispose-end', 'after-scope'])
  })

  it('prefers Symbol.asyncDispose when both are implemented', async () => {
    const calls: string[] = []
    const disposable = {
      [Symbol.dispose]() {
        calls.push('sync')
      },
      [Symbol.asyncDispose]() {
        calls.push('async')
        return Promise.resolve()
      },
    }

    await run(function* () {
      yield* scoped(function* () {
        yield* using(disposable)
      })
    })

    expect(calls).toEqual(['async'])
  })

  it('disposes with the value as `this`', async () => {
    const bound: boolean[] = []

    const disposable = {
      tag: 'me',
      [Symbol.dispose]() {
        bound.push(this === disposable)
      },
    }

    await run(function* () {
      yield* scoped(function* () {
        yield* using(disposable)
      })
    })

    expect(bound).toEqual([true])
  })

  it('fails EffectErrors.Using for a value without a dispose symbol (nothing acquired)', async () => {
    const outcome = await run(function* () {
      const result = yield* attempt(using({ nope: true } as unknown as Disposable))

      return isFailure(result) ? { error: result.error, message: result.message } : 'no-fail'
    })

    expect(unwrap(outcome)).toEqual({
      error: EffectErrors.Using,
      message: 'using() value must implement Symbol.dispose or Symbol.asyncDispose',
    })
    expect(EffectErrors.Using).toBe('std:effect.using')
  })

  it('disposes when the owning task is halted', async () => {
    let disposed = false

    await run(function* () {
      const scope = yield* useScope()

      const task = scope.run(function* () {
        yield* using({
          [Symbol.dispose]() {
            disposed = true
          },
        })
        yield* suspend()
      })

      yield* sleep(1)
      expect(disposed).toBe(false)

      yield* task.halt()
    })

    expect(disposed).toBe(true)
  })
})

describe('useAbortSignal', () => {
  it('is live inside the scope and aborted once the scope ends', async () => {
    let signal: AbortSignal | undefined

    const outcome = await run(function* () {
      const insideScope = yield* scoped(function* () {
        signal = yield* useAbortSignal()
        yield* sleep(1)
        return signal.aborted
      })

      return { insideScope, afterScope: signal!.aborted }
    })

    expect(unwrap(outcome)).toEqual({ insideScope: false, afterScope: true })
  })

  it('aborts when the owning task is halted (cancellation bridge for promise APIs)', async () => {
    let aborted = false

    await run(function* () {
      const scope = yield* useScope()

      const task = scope.run(function* () {
        const signal = yield* useAbortSignal()
        signal.addEventListener('abort', () => {
          aborted = true
        })
        yield* suspend()
      })

      yield* sleep(1)
      expect(aborted).toBe(false)

      yield* task.halt()
    })

    expect(aborted).toBe(true)
  })

  it('each call yields its own signal', async () => {
    const outcome = await run(function* () {
      const a = yield* useAbortSignal()
      const b = yield* useAbortSignal()

      return a !== b
    })

    expect(unwrap(outcome)).toBe(true)
  })
})
