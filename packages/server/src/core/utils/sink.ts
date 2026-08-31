// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt, fork, sleep } from 'std:effect'
import { isFailure } from 'std:result'

import type { Helpers } from '../types/helpers'

/** A batching sink for exporters: `push` rows, they leave by size or age, one batch at a time. */
export const createSink = <T>(options: Helpers.SinkOptions<T>): Helpers.Sink<T> => {
  const size = options.size ?? 200
  const waitMs = options.waitMs ?? 1000
  const maxPending = options.maxPending ?? 10_000
  const pending: T[] = []
  const stats = { sent: 0, dropped: 0, failed: 0 }
  let sending = false
  let failing = false

  const flush = function* (): Operation<void> {
    if (sending) {
      return
    }

    sending = true

    try {
      while (pending.length > 0) {
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
    }
  }

  return {
    stats,

    push: row => {
      pending.push(row)

      if (pending.length > maxPending) {
        pending.shift()
        stats.dropped += 1
      }
    },
    *start() {
      yield* fork(function* () {
        for (;;) {
          yield* sleep(waitMs)
          if (pending.length > 0) {
            yield* flush()
          }
        }
      })
    },
    flush,
  }
}
