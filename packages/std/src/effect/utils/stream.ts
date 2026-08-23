import { isFailure } from 'std:result'

import { call } from '../base/call'
import { ensure } from '../base/ensure'
import { fork } from '../base/spawn'
import { withResolvers } from '../base/with-resolvers'
import type { Flow, Operation, Subscription } from '../types/operation'

import { attempt } from './attempt'
import { createQueue } from './queue'

/**
 * A Flow as a platform `ReadableStream`: PULL-paced — the stream asks for one item per `pull`,
 * so stream backpressure reaches the Flow (nothing is read ahead). The subscription opens in the
 * calling scope and the pump is a task of it; `cancel()` on the stream halts the pump. A Flow
 * that closes with a Result failure errors the stream with that failure; any other close value
 * closes it cleanly.
 */
export function* toReadable<T>(flow: Flow<T, unknown>): Operation<ReadableStream<T>> {
  type Step = IteratorResult<T, unknown>
  const demand = createQueue<(step: Step) => void, void>()
  // the subscription is opened INSIDE the pump task so that cancelling the stream (halting the
  // pump) also releases whatever the Flow holds; opening failures are surfaced through `ready`
  const ready = withResolvers<void>('toReadable ready')

  const pump = yield* fork(function* () {
    const opened = yield* attempt(flow)
    if (isFailure(opened)) {
      ready.reject(opened)
      return
    }
    const subscription = opened.value
    ready.resolve(undefined)
    for (;;) {
      const want = yield* demand.next()
      if (want.done) {
        return
      }
      const step = yield* subscription.next()
      want.value(step)
      if (step.done) {
        demand.close(undefined)
        return
      }
    }
  })
  yield* ready.operation

  const take = () =>
    new Promise<Step>(resolve => {
      demand.add(resolve)
    })

  return new ReadableStream<T>({
    async pull(controller) {
      const step = await take()
      if (!step.done) {
        controller.enqueue(step.value)
        return
      }
      if (isFailure(step.value)) {
        controller.error(step.value)
        return
      }
      controller.close()
    },
    async cancel() {
      demand.close(undefined)
      await pump.halt()
    },
  })
}

/**
 * A platform `ReadableStream` as a Flow: one chunk per `next()`, read through a locked reader
 * that is CANCELLED when the consuming scope closes (a halted consumer releases the source
 * instead of leaving it locked and pending). Closes with `undefined` once the stream ends.
 */
export const fromReadable = <T>(stream: ReadableStream<T>): Flow<T, void> => ({
  *[Symbol.iterator]() {
    const reader = stream.getReader()
    let finished = false
    yield* ensure(() => {
      if (!finished) {
        void reader.cancel().catch(() => {})
      }
    })
    const subscription: Subscription<T, void> = {
      *next() {
        const result = yield* call(() => reader.read())
        if (result.done) {
          finished = true
          reader.releaseLock()
          return { done: true as const, value: undefined }
        }
        return { done: false as const, value: result.value }
      },
    }
    return subscription
  },
})
