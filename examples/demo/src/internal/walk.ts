/** The client walk-through's own helpers (`utils/walk.ts`) — never exported by the barrel. */
import type { Flow, Operation } from 'std:effect'

/** How long the walk waits for the queue's worker to settle a job: 100 × 50 ms. */
export const JOB_POLLS = 100
export const JOB_POLL_MS = 50

/** Up to `max` items of a flow (all of it by default). */
export function* drain<T>(flow: Flow<T, void>, max = Infinity): Operation<T[]> {
  const out: T[] = []
  const subscription = yield* flow

  while (out.length < max) {
    const step = yield* subscription.next()

    if (step.done) {
      break
    }

    out.push(step.value)
  }

  return out
}

/** A one-chunk upload body of `size` bytes. */
export const bytesOf = (size: number): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(size).fill(1))
      controller.close()
    },
  })
