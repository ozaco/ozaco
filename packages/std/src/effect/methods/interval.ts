import type { Stream } from '../types/operation'

import { createSignal } from './signal'
import { resource } from './resource'

export const interval = (milliseconds: number): Stream<void, never> =>
  resource(function* (provide) {
    let signal = createSignal<void, never>()

    let id = setInterval(signal.send, milliseconds)

    try {
      yield* provide(yield* signal)
    } finally {
      clearInterval(id)
    }
  })
