import type { Operation } from 'std:effect'
import { each, into, spawn } from 'std:effect'
import { Logger } from 'std:logger'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Msg, Subscription as NatsSubscription } from 'nats'

export const consume = function* (
  sub: NatsSubscription,
  handle: (msg: Msg) => Operation<unknown, AnyType>,
) {
  yield* spawn(function* () {
    const natsStream = into<Msg>(sub as AsyncIterable<Msg>)

    for (const msg of yield* each(natsStream)) {
      yield* spawn(function* () {
        try {
          yield* handle(msg)
        } catch (error) {
          const failure = asFailure(error)
          if ((yield* Logger.context.get()) !== undefined) {
            yield* Logger.actions.warn('nats:handler-failed', failure)
          }
        }
      })

      yield* each.next()
    }
  })
}
