import { resource } from '../base/resource'
import type { Flow } from '../types/operation'

import { createSignal } from './signal'

/** A {@link Flow} that produces a value every `milliseconds`, bound to the current scope. */
export const interval = (milliseconds: number): Flow<void, never> =>
  resource(function* (provide) {
    const signal = createSignal<void, never>()

    const id = setInterval(signal.send, milliseconds)

    try {
      yield* provide(yield* signal)
    } finally {
      clearInterval(id)
    }
  })
