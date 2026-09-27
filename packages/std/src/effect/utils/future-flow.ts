import { isFailure } from 'std:result'

import { createFuture } from '../base/future'
import { EffectErrors } from '../errors'
import { rendezvous } from '../internal/rendezvous'
import type { Flow, FutureFlow, Scope, Task } from '../types/operation'

import { allSettled } from './all-settled'
import { run } from './run'
import { until } from './until'

/**
 * A Flow as a {@link FutureFlow}: the SAME value works on both sides. `yield*` opens the flow
 * inline — unchanged Flow semantics. `for await` runs a demand-pulled pump as a detached task of
 * `scope` (one per iterator; breaking out halts it). `cancel()` halts every open pump — a
 * `Future`, so `await` or `yield*` it. `done` settles once the async side finished.
 */
export const createFutureFlow = <T>(scope: Scope, flow: Flow<T, void>): FutureFlow<T> => {
  const jobs = new Set<Task<unknown>>()
  const done = createFuture<void>()
  let settled = false

  const settleDone = () => {
    if (!settled) {
      settled = true
      done.resolve(undefined)
    }
  }

  const open = (): AsyncIterator<T, undefined> => {
    const bridge = rendezvous<T>()

    const task = scope.run(
      function* () {
        const subscription = yield* flow

        for (;;) {
          const live = yield* until(bridge.wait())

          if (!live) {
            return
          }

          const step = yield* subscription.next()
          bridge.settle(step.done ? { done: true, value: undefined } : step)

          if (step.done) {
            return
          }
        }
      },
      { detached: true },
    )

    jobs.add(task)

    // the task promise resolves a Result and never rejects: a failing pump fails the iterator,
    // a completed or halted one (cancel, break) closes it cleanly
    void task.then(outcome => {
      jobs.delete(task)

      if (isFailure(outcome) && outcome.error !== EffectErrors.Halted) {
        bridge.reject(outcome)
      }

      bridge.close()

      // `done` is the async side as a whole: the last open iteration settles it
      if (jobs.size === 0) {
        settleDone()
      }

      return null
    })

    return {
      next: () => bridge.next(),

      return: async () => {
        bridge.close()
        await task.halt()
        return { done: true, value: undefined }
      },
    }
  }

  return {
    [Symbol.iterator]: () => flow[Symbol.iterator](),
    [Symbol.asyncIterator]: open,
    done: done.future,

    cancel: () =>
      run(function* () {
        settleDone()
        const halting = [...jobs]
        jobs.clear()
        yield* allSettled(halting.map(job => job.halt()))
      }),
  }
}
