// oxlint-disable import/exports-last
import type { Helpers } from 'ai:core'
import type { Flow, Operation, Queue, Subscription } from 'std:effect'
import { createQueue, fork, operation } from 'std:effect'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

/** The OpenAI SSE sentinel that ends a token stream. */
export const SSE_DONE = '[DONE]'

/** Split a buffered SSE text region into complete events, returning the unconsumed tail. */
const splitEvents = (buffer: string): { events: string[]; rest: string } => {
  const parts = buffer.split(/\r?\n\r?\n/u)
  const rest = parts.pop() ?? ''
  return { events: parts, rest }
}

/** Collect the `data:` lines of one SSE event into a single payload string. */
const eventData = (event: string): string =>
  event
    .split(/\r?\n/u)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')

/** Wrap a queue as a single-consumer {@link Flow}. */
const asFlow = <T>(queue: Queue<T, Helpers.StreamClose>): Flow<T, Helpers.StreamClose> =>
  ({
    *[Symbol.iterator]() {
      return queue
    },
  }) as Flow<T, Helpers.StreamClose>

interface PumpInput<T> {
  readonly subscription: Subscription<Uint8Array, void>
  readonly queue: Queue<T, Helpers.StreamClose>
  readonly parse: (data: string) => Operation<T | undefined>
}

/** Drain the raw byte subscription, parse each complete SSE event, and feed the queue. A raised
 * failure (mid-stream `{"error":…}` frame, unparseable chunk, transport fault) closes the queue
 * with that Failure instead of a clean `true`. */
const pump = operation(function* <T>(input: PumpInput<T>): Generator<AnyType, void, AnyType> {
  const decoder = new TextDecoder()
  let buffer = ''
  let close: Helpers.StreamClose = true
  try {
    for (;;) {
      const step = yield* input.subscription.next()
      if (step.done) {
        break
      }
      buffer += decoder.decode(step.value, { stream: true })
      const { events, rest } = splitEvents(buffer)
      buffer = rest
      for (const event of events) {
        const data = eventData(event)
        // a comment/keep-alive event has no `data:` payload — skip it, never conflate the empty
        // payload with the `[DONE]` sentinel (that would truncate the stream mid-flight)
        if (data.length === 0) {
          continue
        }
        const value = yield* input.parse(data)
        if (value === undefined) {
          return
        }
        input.queue.add(value)
      }
    }
    buffer += decoder.decode()
    const tail = eventData(buffer)
    if (tail.length > 0) {
      const value = yield* input.parse(tail)
      if (value !== undefined) {
        input.queue.add(value)
      }
    }
  } catch (error) {
    close = asFailure(error)
  } finally {
    input.queue.close(close)
  }
})

/**
 * Turn a raw SSE byte flow (from `response.raw()`) into a parsed value flow. `parse` maps one
 * event's `data:` payload to a value, `undefined` for the `[DONE]` sentinel, or RAISES to close
 * the flow with a Failure (mid-stream error frames, garbage chunks).
 *
 * Subscribes to `raw` in the CALLING task, then forks the drain pump with the ready subscription —
 * forking the subscribe itself would race the first bytes (`fork` only runs a child to its first
 * suspension, which sits INSIDE the subscribe). Halting the consuming scope tears the pump down
 * and aborts the request that produced `raw` (its abort signal is owned by the same scope).
 */
export const sseFlow = operation(function* <T>(
  raw: Flow<Uint8Array, void>,
  parse: (data: string) => Operation<T | undefined>,
): Generator<AnyType, Flow<T, Helpers.StreamClose>, AnyType> {
  const subscription = yield* raw
  const queue = createQueue<T, Helpers.StreamClose>()
  yield* fork(() => pump({ subscription, queue, parse }))
  return asFlow(queue)
})

interface CopyInput {
  readonly subscription: Subscription<Uint8Array, void>
  readonly queue: Queue<Uint8Array, Helpers.StreamClose>
}

const copy = operation(function* (input: CopyInput): Generator<AnyType, void, AnyType> {
  let close: Helpers.StreamClose = true
  try {
    for (;;) {
      const step = yield* input.subscription.next()
      if (step.done) {
        break
      }
      input.queue.add(step.value)
    }
  } catch (error) {
    close = asFailure(error)
  } finally {
    input.queue.close(close)
  }
})

/**
 * Re-channel a raw byte flow into a `Flow<Uint8Array, Helpers.StreamClose>` forwarding chunks
 * verbatim — clean end closes `true`, a mid-flight fault closes with the Failure. Same
 * subscribe-then-fork contract as {@link sseFlow}. Used by `ttsStream`.
 */
export const byteFlow = operation(function* (
  raw: Flow<Uint8Array, void>,
): Generator<AnyType, Flow<Uint8Array, Helpers.StreamClose>, AnyType> {
  const subscription = yield* raw
  const queue = createQueue<Uint8Array, Helpers.StreamClose>()
  yield* fork(() => copy({ subscription, queue }))
  return asFlow(queue)
})
