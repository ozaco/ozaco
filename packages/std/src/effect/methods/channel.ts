import type { Channel } from '../types/operation'

import { lift } from './lift'
import { createSignal } from './signal'

export const createChannel = <T, TClose = void>(): Channel<T, TClose> => {
  const signal = createSignal<T, TClose>()

  return {
    send: lift(signal.send),
    close: lift(signal.close),
    [Symbol.iterator]: signal[Symbol.iterator],
  }
}
