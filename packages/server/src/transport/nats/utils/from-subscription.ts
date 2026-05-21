import type { Stream } from 'std:effect'
import { createSignal, resource, spawn, until } from 'std:effect'

export const fromNatsSubscription = <T>(sub: AsyncIterable<T>): Stream<T, void> =>
  resource(function* (provide) {
    const signal = createSignal<T, void>()

    yield* spawn(function* () {
      const iterator = sub[Symbol.asyncIterator]()
      try {
        while (true) {
          const next = yield* until(iterator.next(), 'nats:subscription:next')

          if (next.done) {
            signal.close()
            return
          }

          signal.send(next.value)
        }
      } catch {
        signal.close()
      }
    })

    yield* provide(yield* signal)
  })
