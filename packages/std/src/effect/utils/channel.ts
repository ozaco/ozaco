import { lift } from '../base/lift'
import type { Channel } from '../types/operation'

import { createSignal } from './signal'

/**
 * Create a new channel: like a signal, but `send`/`close` are operations, making the hand-off
 * explicit inside effect code.
 */
export function createChannel<T, TClose = void>(): Channel<T, TClose> {
  const signal = createSignal<T, TClose>()

  return {
    send: lift(signal.send),
    close: lift(signal.close),
    [Symbol.iterator]: signal[Symbol.iterator],
  }
}
