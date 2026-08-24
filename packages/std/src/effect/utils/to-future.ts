import type { Result } from 'std:result'
import { fail, isFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import { createFuture } from '../base/future'
import type { Future, Operation, Scope } from '../types/operation'

import { attempt } from './attempt'

export interface ToFutureOptions<T> {
  /** Abort the AWAITED task (settles `fail('halted')`); a `yield*`ed operation needs no
   * signal — it is cancelled with the caller's task. */
  readonly signal?: AbortSignal | undefined

  /** Keep the awaited task alive until this settles — for a value whose resources must outlive
   * the call itself (a stream reply that is consumed later). */
  readonly hold?: ((value: T) => Operation<void> | null) | undefined
}

/**
 * An operation as a hybrid {@link Future}: the value IS the operation — `yield*` composes it
 * INLINE (the caller's task, the caller's scope, cancelled with it) — and `then`/`catch`/
 * `finally` ride along non-enumerably, each starting a FRESH detached task of `scope` whose
 * settlement is the std `Result` (failures resolve; `unwrap` it). Both sides are symmetric:
 * every consumption, `yield*` or `await`, is its own run; nothing runs untouched. `hold` keeps
 * an awaited task alive after its value settles; `signal` halts it.
 */
export const toFuture = <T>(
  scope: Scope,
  op: () => Operation<T>,
  options?: ToFutureOptions<T>,
): Future<T> => {
  const operation = {
    [Symbol.iterator]: () => op()[Symbol.iterator](),
  }

  const settled = (): Promise<Result<T>> => {
    if (options?.signal?.aborted) {
      return Promise.resolve(fail('halted', 'aborted before start') as AnyType)
    }

    // hold: resolve the value EARLY, keep the task (and what it opened) alive on the hold op
    if (options?.hold) {
      const early = createFuture<T>()
      const hold = options.hold

      const task = scope.run(
        function* () {
          const outcome = yield* attempt(op)

          if (isFailure(outcome)) {
            early.resolve(outcome as AnyType)
            return
          }

          const keep = hold(outcome.value)
          early.resolve(outcome.value)

          if (keep) {
            yield* keep
          }
        },
        { detached: true },
      )

      options.signal?.addEventListener(
        'abort',
        () => {
          early.resolve(fail('halted', 'the operation was aborted') as AnyType)
          // halt() is a lazy Future — consuming it is what interrupts the task
          void task.halt().catch(() => {})
        },
        { once: true },
      )

      return early.future as unknown as Promise<Result<T>>
    }

    // plain: the detached task IS the settlement — its future resolves the Result, never rejects
    const task = scope.run(op, { detached: true })
    options?.signal?.addEventListener(
      'abort',
      // halt() is a lazy Future — consuming it is what interrupts the task
      () => void task.halt().catch(() => {}),
      { once: true },
    )
    return task as unknown as Promise<Result<T>>
  }

  return Object.defineProperties(operation, {
    [Symbol.toStringTag]: { enumerable: false, value: 'Future' },

    // oxlint-disable-next-line no-thenable -- a Future IS thenable by design
    then: {
      enumerable: false,
      value: (...args: AnyType[]) => settled().then(...args),
    },

    catch: {
      enumerable: false,
      value: (...args: AnyType[]) => settled().catch(...args),
    },

    finally: {
      enumerable: false,
      value: (...args: AnyType[]) => settled().finally(...args),
    },
  }) as unknown as Future<T>
}
