import type { Operation } from 'std:effect'
import { into, spawn, streamForEach } from 'std:effect'
import type { AnyType } from 'std:shared'

import type { Msg, Subscription as NatsSubscription } from 'nats'

export const consume = function* (
  sub: NatsSubscription,
  handle: (msg: Msg) => Operation<unknown, AnyType>,
) {
  yield* spawn(function* () {
    yield* streamForEach(into<Msg>(sub as AsyncIterable<Msg>), msg => spawn(() => handle(msg)))
  })
}
