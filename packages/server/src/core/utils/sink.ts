// oxlint-disable import/exports-last
import type { Operation } from 'std:effect'
import { attempt, fork, sleep } from 'std:effect'
import { isFailure } from 'std:result'

/** A batching sink: rows collect in memory and leave in batches (by size or age). */
export interface Sink<T> {
  /** queue one row (drops the oldest past `maxPending`). */
  push(row: T): void

  /** start the age timer in the current scope. */
  start(): Operation<void>

  /** send everything pending now. */
  flush(): Operation<void>
  readonly stats: { sent: number; dropped: number; failed: number }
}

interface SinkOptions<T> {
  /** rows per batch. Default 200. */
  readonly size?: number | undefined

  /** max time a row waits. Default 1000. */
  readonly ms?: number | undefined

  /** rows held before the oldest are dropped. Default 10 000. */
  readonly maxPending?: number | undefined

  /** deliver one batch; a failure is counted, never raised. */
  readonly send: (rows: readonly T[]) => Operation<void>
}

/** A batching sink for exporters: `push` rows, they leave by size or age, one batch at a time. */
export const createSink = <T>(options: SinkOptions<T>): Sink<T> => {
  const size = options.size ?? 200
  const ms = options.ms ?? 1000
  const maxPending = options.maxPending ?? 10_000
  const pending: T[] = []
  const stats = { sent: 0, dropped: 0, failed: 0 }
  let sending = false

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
        } else {
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
          yield* sleep(ms)
          if (pending.length > 0) {
            yield* flush()
          }
        }
      })
    },
    flush,
  }
}
