import type { Operation, Stream } from '../types/operation'

import { createSignal } from './signal'
import { lift } from './lift'

export interface Channel<T, TClose> extends Stream<T, TClose> {
  send(message: T): Operation<void>
  close(value: TClose): Operation<void>
}

export const createChannel = <T, TClose = void>(): Channel<T, TClose> => {
  let signal = createSignal<T, TClose>()

  return {
    send: lift(signal.send),
    close: lift(signal.close),
    [Symbol.iterator]: signal[Symbol.iterator],
  }
}
