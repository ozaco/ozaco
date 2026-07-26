import type { Operation, Stream } from 'std:effect'
import { ensure, operation, race, until, withResolvers } from 'std:effect'
import { asFailure, isFailure } from 'std:result'

/**
 * IO action — adapt an effect `Stream<Uint8Array>` into a web `ReadableStream<Uint8Array>`, the
 * inverse of `fromReadable`. Free of any `node:*` import so it bundles for the browser (`WebIO`); the
 * result is a WHATWG stream usable as a `Response` body, a structured-clone transfer, or anything
 * that reads bytes. Reached as `IO.actions.toReadable(source)`.
 *
 * Returns `{ readable, pump }`: the `readable` is live immediately (its controller is captured in
 * `start`), and `pump` is the `Operation` that drains `source` into it. The pump is RETURNED rather
 * than spawned so the caller `yield*`s it inside whatever scope owns the source — the source (and any
 * in-flight upstream request feeding it) then stays alive until the body is fully drained, paced by
 * the consumer's `pull()` (backpressure). A failure close (`Result.Failure`) becomes
 * `controller.error()` so a truncated source surfaces as a stream error rather than a clean end; the
 * consumer's `cancel()` ends the pump immediately, even while it is parked waiting for the next value.
 */
export const toReadable = operation(function* (source: Stream<Uint8Array, unknown>) {
  let controller: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  let settled = false

  // Resolves the moment the consumer walks away. The drain loop parks in `subscription.next()`
  // whenever the source is idle, and nothing about a cancelled ReadableStream interrupts that on its
  // own — a `cancelled` flag is only seen once ANOTHER value shows up. For a long-lived feed (SSE)
  // that means one more production cycle per abandoned connection, and for a source that never
  // produces again, a pump that never returns and a scope that never unwinds. Racing the whole drain
  // against this signal is what makes departure, not the next chunk, end the pump.
  const departed = withResolvers<void>('readable cancelled')

  // resolves when the consumer pulls; the pump parks here once the controller is saturated
  let wake: (() => void) | null = null
  const awaitPull = () =>
    new Promise<void>(resolve => {
      wake = resolve
    })

  const settle = (close: unknown) => {
    if (settled || cancelled) {
      return
    }
    settled = true
    if (isFailure(close)) {
      controller.error(close)
    } else {
      controller.close()
    }
  }

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    pull() {
      const resume = wake
      wake = null
      resume?.()
    },
    cancel() {
      cancelled = true
      wake?.()
      departed.resolve()
    },
  })

  /** Drain `source` into the controller, paced by `pull()`. Halted wholesale when the consumer goes. */
  const drain = function* (): Operation<void> {
    const subscription = yield* source

    try {
      while (true) {
        if (cancelled) {
          break
        }
        const next = yield* subscription.next()
        if (next.done) {
          settle(next.value ?? true)
          break
        }
        if (cancelled) {
          break
        }
        controller.enqueue(next.value)
        if ((controller.desiredSize ?? 1) <= 0) {
          yield* until(awaitPull())
        }
      }
    } catch (error) {
      settle(asFailure(error))
    }
  }

  const pump: Operation<void> = {
    *[Symbol.iterator]() {
      // terminate the readable when this pump is torn down mid-flight — halt runs neither catch nor
      // finally, so a server shutdown that halts the pump would otherwise leave the controller open
      // and a consuming HTTP connection hanging. `ensure` runs on scope teardown (incl. halt).
      yield* ensure(function* () {
        if (!settled && !cancelled) {
          try {
            controller.close()
          } catch {
            // controller already closed/errored — nothing to do
          }
        }
      })

      // Two tasks for the whole body, not per chunk: `race` halts the loser, so a cancel tears the
      // drain (and with it the subscription on the source) down where it stands.
      yield* race([drain(), departed.operation])
    },
  }

  return { readable, pump }
})
