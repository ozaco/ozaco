import { defineAction, defineService } from 'server:core'
import { stream } from 'std:effect'
import { fail } from 'std:result'

// deliberately naive recursion — CPU-bound work worth pushing off the main thread onto a worker pool
const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2))

/**
 * A small CPU-bound compute service. It is hosted INSIDE each worker (see `./entry`); the main thread
 * (see `./main`) dispatches to it through the worker transport without registering it locally, so the
 * work runs off the main thread. Shared by both sides only for its action references + types.
 */
export const ComputeService = defineService({
  name: 'compute',
  version: '0.0.0',

  actions: {
    fib: defineAction(function* (n: number) {
      if (n === 35) {
        yield* fail('unexpected', 'cannot be 35')
      }

      return { n, result: fib(n) }
    }),

    // a streamed result, to show streaming flows over the worker port too
    range: defineAction(function* (n: number) {
      return stream(
        (async function* () {
          for (let i = 1; i <= n; i++) {
            yield { i }
          }
        })(),
      )
    }),
  },

  *setup() {},
})
