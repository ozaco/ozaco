import { resource } from '../base/resource'
import { SignalQueueFactoryContext } from '../internal/contexts'
import type { Queue, Signal, Subscription } from '../types/operation'

/**
 * Create a new signal: convert plain JavaScript callbacks (event listeners, timers) into a Flow.
 * Values sent before a subscriber arrives are dropped; every subscriber gets its own queue.
 */
export function createSignal<T, TClose = never>(): Signal<T, TClose> {
  const subscribers = new Set<Queue<T, TClose>>()

  const subscribe = resource<Subscription<T, TClose>>(function* (provide) {
    const newQueue = yield* SignalQueueFactoryContext.expect()
    const queue = newQueue<T, TClose>()
    subscribers.add(queue)

    try {
      yield* provide({ next: queue.next })
    } finally {
      subscribers.delete(queue)
    }
  })

  const send = (value: T) => {
    // deliberate copy: delivering can tear a subscription down mid-iteration, and a Set mutated
    // while iterated would silently skip peers
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const queue of [...subscribers]) {
      queue.add(value)
    }
  }

  const close = (value: TClose) => {
    // oxlint-disable-next-line unicorn/no-useless-spread
    for (const queue of [...subscribers]) {
      queue.close(value)
    }
  }

  return { ...subscribe, send, close }
}
