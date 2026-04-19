import type { Stream } from '../types/operation'

import { resource } from './resource'
import { createSignal } from './signal'

export const throttle = <T>(source: Stream<T, unknown>, ms: number): Stream<T, never> =>
  resource(function* (provide) {
    const output = createSignal<T, never>()

    yield* provide(yield* output)

    const subscription = yield* source
    let lastEmit = 0

    let done = false
    while (!done) {
      const next = yield* subscription.next()
      if (next.done) {
        done = true
      } else {
        const now = Date.now()
        if (now - lastEmit >= ms) {
          lastEmit = now
          output.send(next.value)
        }
      }
    }

    output.close(undefined as never)
  })
