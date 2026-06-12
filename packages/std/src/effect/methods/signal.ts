import type { Context, Queue, Signal, Subscription } from '../types/operation'

import { createContext } from './context'
import { createQueue } from './queue'
import { resource } from './resource'

export const SignalQueueFactory: Context<typeof createQueue> = createContext(
  'Signal.createQueue',
  createQueue,
)

export const createSignal = <T, TClose = never>(): Signal<T, TClose> => {
  const subscribers = new Set<Queue<T, TClose>>()

  const subscribe = resource<Subscription<T, TClose>>(function* (provide) {
    const newQueue = yield* SignalQueueFactory.expect()
    const queue = newQueue<T, TClose>()
    subscribers.add(queue)

    try {
      yield* provide({ next: queue.next })
    } finally {
      subscribers.delete(queue)
    }
  })

  const send = (value: T) => {
    for (const queue of subscribers) {
      queue.add(value)
    }
  }

  const close = (value: TClose) => {
    for (const queue of subscribers) {
      queue.close(value)
    }
  }

  const result = subscribe as Signal<T, TClose>

  result.send = send
  result.close = close

  return result
}
