import type { Operation } from 'std:effect'
import { spawn } from 'std:effect'
import { Logger } from 'std:logger'
import { asFailure } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Msg, Subscription as NatsSubscription } from 'nats'

import { fromNatsSubscription } from './from-subscription'

export const consume = function* (
  sub: NatsSubscription,
  handle: (msg: Msg) => Operation<unknown, AnyType>,
) {
  yield* spawn(function* () {
    const messages = yield* fromNatsSubscription<Msg>(sub as AsyncIterable<Msg>)

    while (true) {
      const next = yield* messages.next()
      if (next.done) {
        return
      }

      yield* spawn(function* () {
        try {
          yield* handle(next.value)
        } catch (error) {
          const failure = asFailure(error)
          if ((yield* Logger.context.get()) !== undefined) {
            yield* Logger.actions.warn('nats:handler-failed', failure)
          }
        }
      })
    }
  })
}
