import type { Helpers } from '../types/helpers'
import type { Stream, Subscription } from '../types/operation'

import { call } from './call'

export const subscribe = <T, R>(iter: AsyncIterator<T, R>): Subscription<T, R> => ({
  next: () => call(() => iter.next()),
})

export const stream = <T, R>(iterable: Helpers.AsyncIterableType<T, R>): Stream<T, R> => ({
  // oxlint-disable-next-line require-yield
  *[Symbol.iterator]() {
    return subscribe(iterable[Symbol.asyncIterator]())
  },
})
