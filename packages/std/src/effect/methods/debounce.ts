import type { Stream } from '../types/operation'

import { resource } from './resource'
import { createSignal } from './signal'

export const debounce = <T>(source: Stream<T, unknown>, ms: number): Stream<T, never> =>
  resource(function* (provide) {
    const output = createSignal<T, never>()
    let timerId: ReturnType<typeof setTimeout> | undefined

    yield* provide(yield* output)

    const subscription = yield* source

    let done = false
    while (!done) {
      const next = yield* subscription.next()
      if (next.done) {
        done = true
      } else {
        if (timerId !== undefined) {
          clearTimeout(timerId)
        }
        const value = next.value
        timerId = setTimeout(() => output.send(value), ms)
      }
    }

    if (timerId !== undefined) {
      clearTimeout(timerId)
    }
    output.close(undefined as never)
  })
