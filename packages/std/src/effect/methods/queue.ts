import type { Helpers } from '../types/helpers'
import type { Subscription } from '../types/operation'

import { action } from './action'

export interface Queue<T, TClose> extends Subscription<T, TClose> {
  add(item: T): void
  close(value: TClose): void
}

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
