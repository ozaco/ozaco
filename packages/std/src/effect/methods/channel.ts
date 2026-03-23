import type { Operation, Stream } from '../types/operation'

import { lift } from './lift'
import { createSignal } from './signal'

export interface Channel<T, TClose> extends Stream<T, TClose> {
  send(message: T): Operation<void>
  close(value: TClose): Operation<void>
}

export const createChannel = <T, TClose = void>(): Channel<T, TClose> => {
  const signal = createSignal<T, TClose>()

  return {
    send: lift(signal.send),
    close: lift(signal.close),
    [Symbol.iterator]: signal[Symbol.iterator],
  }
}
