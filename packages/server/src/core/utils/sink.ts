// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt, createGate, fork, race, sleep } from 'std:effect'
import { isFailure } from 'std:result'

import type { Helpers } from '../types/helpers'

/**
 * A batching sink for exporters: `push` rows, they leave in batches of `size` — as soon as a
 * batch is FULL (an early flush, so a burst never overflows `maxPending` between two beats), the
 * rest on the next beat (every `waitMs`) — one send at a time. `start()` forks the beat once (a
 * second call while it runs — a node restarted after a stop — starts no second one). `flush()`
 * waits for a send already in flight and then sends everything pending (the stop-time flush loses
 * nothing). A failed batch is counted (`stats.failed`), never raised; `onError` hears the first
 * failure of a streak.
 */
export const createSink = <T>(options: Helpers.SinkOptions<T>): Helpers.Sink<T> => {
  const size = Math.max(1, options.size ?? 200)
  const waitMs = options.waitMs ?? 1000
  const maxPending = options.maxPending ?? 10_000
  const pending: T[] = []
  const stats = { sent: 0, dropped: 0, failed: 0 }

  // `full` wakes the beat when a batch filled up; `idle` wakes a `flush()` parked behind a send
  const full = createGate('sink full')
  const idle = createGate('sink idle')
  let sending = false
  let failing = false
  let beating = false
  const busy = () => sending

  /** Send pending rows in batches of `size` — every row (`all`), or only FULL batches (a
   * partial one waits for the beat). One send at a time: a send in flight is waited for. */
  const drain = function* (all: boolean): Operation<void> {
    // read the flag, wait, read again: a send that started while we slept is waited for too
    while (busy()) {
      yield* idle.wait()
    }

    sending = true

    try {
      while (all ? pending.length > 0 : pending.length >= size) {
        const batch = pending.splice(0, size)
        const outcome = yield* attempt(() => options.send(batch))

        if (isFailure(outcome)) {
          stats.failed += batch.length

          if (!failing) {
            failing = true
            options.onError?.(outcome)
          }
        } else {
          failing = false
          stats.sent += batch.length
        }
      }
    } finally {
      sending = false
      idle.notify()
    }
  }

  function* beat(): Operation<'beat'> {
    yield* sleep(waitMs)
    return 'beat'
  }

  function* filled(): Operation<'full'> {
    yield* full.wait()
    return 'full'
  }

  return {
    stats,

    push: row => {
      pending.push(row)

      if (pending.length > maxPending) {
        pending.shift()
        stats.dropped += 1
      }

      if (pending.length >= size) {
        full.notify()
      }
    },
    *start() {
      if (beating) {
        return
      }

      beating = true
      yield* fork(function* () {
        try {
          for (;;) {
            // a FULL batch leaves at once; the rest leaves on the beat
            const woke = pending.length >= size ? 'full' : yield* race([beat(), filled()])

            if (pending.length > 0) {
              yield* drain(woke === 'beat')
            }
          }
        } finally {
          // its scope ended: a later `start` begins a new beat
          beating = false
        }
      })
    },
    flush: () => drain(true),
  }
}
