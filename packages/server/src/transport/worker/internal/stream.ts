import type { Stream, Subscription } from 'std:effect'

export const streamOf = <T, R>(subscription: Subscription<T, R>): Stream<T, R> => ({
  *[Symbol.iterator]() {
    return subscription
  },
})
