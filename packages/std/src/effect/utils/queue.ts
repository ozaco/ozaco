import { action } from '../base/action'
import type { Helpers } from '../types/helpers'
import type { Queue } from '../types/operation'

/**
 * Create a new queue: a buffered rendezvous between one producer and one consumer. Unlike a
 * channel/signal, items added before the consumer arrives are not lost.
 */
export function createQueue<T, TClose = void>(): Queue<T, TClose> {
  type Item = IteratorResult<T, TClose>

  const items: Item[] = []
  const consumers = new Set<Helpers.Resolve<Item>>()

  function enqueue(item: Item) {
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
      }, 'queue.next()')
    },
  }
}
