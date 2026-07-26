import type { Helpers } from '../types/helpers'
import type { Queue, StreamQueue } from '../types/operation'

import { action } from './action'

export const createQueue = <T, TClose>(): Queue<T, TClose> => {
  type Item = IteratorResult<T, TClose>

  const items: Item[] = []
  const consumers = new Set<Helpers.Resolve<Item>>()

  const enqueue = (item: Item) => {
    items.unshift(item)
    while (items.length > 0 && consumers.size > 0) {
      const [consume] = consumers
      const top = items.pop() as Item
      consume!(top)
    }
  }

  return {
    add: value => enqueue({ done: false, value }),
    close: value => enqueue({ done: true, value }),
    *next() {
      const item = items.pop()
      if (item) {
        return item
      }
      return yield* action<Item>(resolve => {
        consumers.add(resolve)
        return () => consumers.delete(resolve)
      })
    },
  }
}

/**
 * A queue wearing a `Stream`'s clothes — for a producer that starts before its consumer.
 *
 * `createChannel` broadcasts: a `send` with nobody subscribed is dropped. That is wrong for a stream
 * you hand to someone else (a transport, a gateway) who subscribes a tick later, because the opening
 * messages vanish. This buffers instead, and every subscription returns the same queue, so it feeds
 * exactly one consumer.
 */
export const createStreamQueue = <T, TClose>(): StreamQueue<T, TClose> => {
  const queue = createQueue<T, TClose>()

  return {
    add: item => queue.add(item),
    close: value => queue.close(value),
    *[Symbol.iterator]() {
      return queue
    },
  }
}
