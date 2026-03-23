import type { Context, Stream, Subscription } from '../types/operation'

import { createContext } from './context'
import { createQueue, type Queue } from './queue'
import { resource } from './resource'

export interface Signal<T, TClose> extends Stream<T, TClose> {
  send(value: T): void
  close(value: TClose): void
}

export const SignalQueueFactory: Context<typeof createQueue> = createContext(
  'Signal.createQueue',
  createQueue,
)

export const createSignal = <T, TClose = never>(): Signal<T, TClose> => {
  let subscribers = new Set<Queue<T, TClose>>()

  let subscribe = resource<Subscription<T, TClose>>(function* (provide) {
    let newQueue = yield* SignalQueueFactory.expect()
    let queue = newQueue<T, TClose>()
    subscribers.add(queue)

    try {
      yield* provide({ next: queue.next })
    } finally {
      subscribers.delete(queue)
    }
  })

  const send = (value: T) => {
    for (let queue of subscribers) {
      queue.add(value)
    }
  }

  const close = (value: TClose) => {
    for (let queue of subscribers) {
      queue.close(value)
    }
  }

  return { ...subscribe, send, close }
}
