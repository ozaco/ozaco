import { isFailure } from 'std:result'
import type { AnyType } from 'std:shared'
import { isAsyncIterable } from 'std:shared'

import type { Operation, Stream, Subscription } from '../types/operation'

import { isSubscription } from './is'
import { operation } from './operation'
import { resource } from './resource'
import { createSignal } from './signal'
import { spawn } from './spawn'
import { until } from './until'

const identity = function* <T, R>(value: T) {
  return value as unknown as R
}

export const into = <T, R = T>(
  source: Iterable<T> | AsyncIterable<T>,
  transform?: (item: T) => Operation<R>,
): Stream<R, void> =>
  resource(function* (provide) {
    const signal = createSignal<R, void>()
    const subscription = yield* signal
    const map = transform ?? identity<T, R>

    yield* spawn(function* () {
      let iterator: AsyncIterator<T> | undefined
      try {
        if (isAsyncIterable(source)) {
          iterator = (source as AsyncIterable<T>)[Symbol.asyncIterator]()
          while (true) {
            const next = yield* until(iterator.next())
            if (next.done) {
              break
            }
            signal.send(yield* map(next.value))
          }
        } else {
          for (const value of source as Iterable<T>) {
            signal.send(yield* map(value))
          }
        }
      } finally {
        // close the async source iterator on teardown so its own finally (fd/handle cleanup) runs —
        // the sync for-of path gets this for free; the manual async loop does not. Best-effort.
        if (iterator?.return) {
          try {
            yield* until(iterator.return())
            // oxlint-disable-next-line no-empty
          } catch {}
        }
        signal.close()
      }
    })

    yield* provide(subscription)
  })

export const collect = operation(function* <R>(
  source: Subscription<unknown, void> | Stream<unknown, void>,
  transform?: (item: AnyType) => Operation<unknown>,
) {
  const subscription = isSubscription(source) ? source : yield* source
  const map = transform ?? identity<unknown, R>
  const items: R[] = []

  while (true) {
    const next = yield* subscription.next()

    if (next.done) {
      if (isFailure(next.value)) {
        yield* next.value
      }
      return items
    }
    items.push(yield* map(next.value) as AnyType)
  }
}, 'collect')
