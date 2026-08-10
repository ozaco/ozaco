import { call } from '../base/call'
import type { Helpers } from '../types/helpers'
import type { Stream, Subscription } from '../types/operation'

/** Wrap an `AsyncIterator` as a {@link Subscription}. */
export const subscribe = <T, R>(iter: AsyncIterator<T, R>): Subscription<T, R> => ({
  next: () => call(() => iter.next()),
})

/** Wrap an `AsyncIterable` as a {@link Stream}. */
export const stream = <T, R>(iterable: Helpers.AsyncIterableType<T, R>): Stream<T, R> => ({
  *[Symbol.iterator]() {
    return subscribe(iterable[Symbol.asyncIterator]())
  },
})
