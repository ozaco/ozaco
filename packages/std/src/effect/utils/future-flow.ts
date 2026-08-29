import { isFailure } from 'std:result'

import { createFuture } from '../base/future'
import type { Helpers } from '../types/helpers'
import type { Flow, FutureFlow, Scope, Task } from '../types/operation'

import { allSettled } from './all-settled'
import { run } from './run'
import { until } from './until'

/** The rendezvous between one async iterator and its effect pump: strictly demand-pulled. */
const rendezvous = <T>(): Helpers.Rendezvous<T> => {
  type Step = IteratorResult<T, undefined>
  type Waiter = { resolve: (step: Step) => void; reject: (error: unknown) => void }
  let waiting: Waiter | null = null
  let wanted: ((live: boolean) => void) | null = null
  let state: 'live' | 'done' | 'failed' = 'live'
  let failure: unknown

  return {
    next: () =>
      new Promise<Step>((resolve, reject) => {
        if (state === 'failed') {
          reject(failure as Error)
          return
        }

        if (state === 'done') {
          resolve({ done: true, value: undefined })
          return
        }

        waiting = { resolve, reject }

        if (wanted) {
          const want = wanted
          wanted = null
          want(true)
        }
      }),

    close: () => {
      if (state === 'live') {
        state = 'done'
      }

      if (waiting) {
        const waiter = waiting
        waiting = null
        waiter.resolve({ done: true, value: undefined })
      }

      if (wanted) {
        const want = wanted
        wanted = null
        want(false)
      }
    },

    wait: () =>
      new Promise<boolean>(resolve => {
        if (state !== 'live') {
          resolve(false)
          return
        }

        if (waiting) {
          resolve(true)
          return
        }

        wanted = resolve
      }),

    settle: step => {
      if (step.done) {
        state = 'done'
      }

      if (waiting) {
        const waiter = waiting
        waiting = null
        waiter.resolve(step)
      }
    },

    reject: error => {
      if (state !== 'live') {
        return
      }

      state = 'failed'
      failure = error

      if (waiting) {
        const waiter = waiting
        waiting = null
        waiter.reject(error as Error)
      }
    },
  }
}

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

      if (isFailure(outcome) && outcome.error !== 'halted') {
        bridge.reject(outcome)
      }

      bridge.close()
      settleDone()
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
