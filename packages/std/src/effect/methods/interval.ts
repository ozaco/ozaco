import type { Stream } from '../types/operation'

import { resource } from './resource'
import { createSignal } from './signal'

export const interval = (milliseconds: number): Stream<void, never> =>
  resource(function* (provide) {
    const signal = createSignal<void, never>()

    const id = setInterval(signal.send, milliseconds)

    try {
      yield* provide(yield* signal)
    } finally {
      clearInterval(id)
    }
  })
