import { createContext, createQueue, createSignal, ensure, useContext } from 'std:effect'
import { fail } from 'std:result'

import type { TransportDef } from 'transport:core'
import { matchTopic, prefixed, TransportErrors, unprefixed } from 'transport:core'

import type { Worker } from './types'

export const StateRef = createContext<Worker.State>('transport:impl/worker')

/** Every install attached to a port: a publish on this side reaches all of them directly (the
 * channel only carries it to the OTHER side). */
export const attached = new WeakMap<Worker.PortLike, Set<Worker.State>>()

export const isFrame = (value: unknown): value is Worker.Frame =>
  typeof value === 'object' &&
  value !== null &&
  (value as Worker.Frame).oz === 'transport' &&
  typeof (value as Worker.Frame).topic === 'string'

/** Hand one frame to every local subscriber whose pattern matches. */
export const deliver = (state: Worker.State, frame: Worker.Frame): number => {
  const topic = unprefixed(state.prefix, frame.topic)
  if (topic === null) {
    return 0
  }

  let delivered = 0
  for (const sub of state.subscribers) {
    if (matchTopic(sub.pattern, topic)) {
      sub.queue.add({ topic, data: new Uint8Array(frame.data), headers: { ...frame.headers } })
      delivered += 1
    }
  }

  return delivered
}

export const driver: TransportDef.Driver = {
  capabilities: {
    durable: false,
    groups: false,
    requestReply: false,
    receipts: false,
    maxPayloadBytes: null,
  },

  *publish({ topic, data, headers }) {
    const state = yield* useContext(StateRef)
    if (state.status === 'closed') {
      return yield* fail(TransportErrors.Closed, 'worker transport drained')
    }

    const frame: Worker.Frame = {
      oz: 'transport',
      topic: prefixed(state.prefix, topic),
      data: new Uint8Array(data),
      headers: { ...headers },
    }
    // both ends see every publish: the other side over the channel, this side directly
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a worker/port channel, not a window
    state.port.postMessage(frame)

    for (const peer of attached.get(state.port) ?? [state]) {
      deliver(peer, frame)
    }

    return null
  },

  *subscribe(topic) {
    const state = yield* useContext(StateRef)
    const queue = createQueue<TransportDef.Raw, void>()
    const subscriber: Worker.Subscriber = { pattern: topic, queue }
    state.subscribers.add(subscriber)

    yield* ensure(() => {
      state.subscribers.delete(subscriber)
      queue.close(undefined)
    })

    return queue
  },

  status: () => ({
    *[Symbol.iterator]() {
      const state = yield* useContext(StateRef)
      const signal = createSignal<TransportDef.Status, void>()

      const subscription = yield* signal
      signal.send(state.status)

      return subscription
    },
  }),

  *drain() {
    const state = yield* useContext(StateRef)
    state.status = 'closed'
  },
}
