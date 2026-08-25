import { call } from '../base/call'
import type { Helpers } from '../types/helpers'
import type { Flow, Subscription } from '../types/operation'

/** Wrap an `AsyncIterator` as a {@link Subscription}. */
export const subscribe = <T, R>(iter: AsyncIterator<T, R>): Subscription<T, R> => ({
  next: () => call(() => iter.next()),
})

/** Wrap an `AsyncIterable` as a {@link Flow}. */
export const flow = <T, R>(iterable: Helpers.AsyncIterableType<T, R>): Flow<T, R> => ({
  *[Symbol.iterator]() {
    return subscribe(iterable[Symbol.asyncIterator]())
  },
})
