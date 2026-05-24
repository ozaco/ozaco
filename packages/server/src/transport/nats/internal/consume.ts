import type { Operation } from 'std:effect'
import { each, into, spawn } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Msg, Subscription as NatsSubscription } from 'nats'

export const consume = function* (
  sub: NatsSubscription,
  handle: (msg: Msg) => Operation<unknown, AnyType>,
) {
  yield* spawn(function* () {
    const natsStream = into<Msg>(sub as AsyncIterable<Msg>)

    for (const msg of yield* each(natsStream)) {
      yield* spawn(() => handle(msg))

      yield* each.next()
    }
  })
}
