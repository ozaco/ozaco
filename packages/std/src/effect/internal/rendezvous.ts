import type { Helpers } from '../types/helpers'

/** The rendezvous between one async iterator and its effect pump: strictly demand-pulled. */
export const rendezvous = <T>(): Helpers.Rendezvous<T> => {
  let waiting: Helpers.RendezvousWaiter<T> | null = null
  let wanted: ((live: boolean) => void) | null = null
  let state: 'live' | 'done' | 'failed' = 'live'
  let failure: unknown

  return {
    next: () =>
      new Promise<IteratorResult<T, undefined>>((resolve, reject) => {
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
