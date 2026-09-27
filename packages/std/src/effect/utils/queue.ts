import { action } from '../base/action'
import type { Helpers } from '../types/helpers'
import type { Queue } from '../types/operation'

/**
 * Create a new queue: a buffered rendezvous between one producer and one consumer. Unlike a
 * channel/signal, items added before the consumer arrives are not lost.
 */
export function createQueue<T, TClose = void>(): Queue<T, TClose> {
  const items: Helpers.QueueItem<T, TClose>[] = []
  const consumers = new Set<Helpers.Resolve<Helpers.QueueItem<T, TClose>>>()

  function enqueue(item: Helpers.QueueItem<T, TClose>) {
    items.unshift(item)
    while (items.length > 0 && consumers.size > 0) {
      const [consume] = consumers
      const top = items.pop() as Helpers.QueueItem<T, TClose>
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
      return yield* action<Helpers.QueueItem<T, TClose>>(resolve => {
        consumers.add(resolve)
        return () => consumers.delete(resolve)
      }, 'queue.next()')
    },
  }
}
