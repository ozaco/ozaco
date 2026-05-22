import { Codec } from 'server:core'
import type { Operation, Scope, Stream } from 'std:effect'
import { createChannel, each, into, spawn } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'

import type { Msg, MsgHdrs, NatsConnection, Subscription as NatsSubscription } from 'nats'
import { headers as createHeaders } from 'nats'

import type { Nats } from '../types'

import { serializeError } from './wire'

const STREAM_EVENT = 'nats-stream-event'
const EVENT_END = 'end'
const EVENT_ERROR = 'error'
const EMPTY: Uint8Array = new Uint8Array(0)

const endHeaders = (): MsgHdrs => {
  const h = createHeaders()
  h.set(STREAM_EVENT, EVENT_END)
  return h
}

const errorHeaders = (): MsgHdrs => {
  const h = createHeaders()
  h.set(STREAM_EVENT, EVENT_ERROR)
  return h
}

const failureFromPayload = (payload: Nats.StreamErrorPayload): Result.Failure<unknown> =>
  fail(payload.error, payload.message, ...(payload.causes ?? [])) as Result.Failure<unknown>

const failureToPayload = (failure: Result.Failure<unknown>): Nats.StreamErrorPayload => ({
  error: serializeError(failure.error),
  message: failure.message,
  causes: failure.causes,
})

export const pumpToNats = function* (
  connection: NatsConnection,
  subject: string,
  source: Stream<unknown, unknown>,
): Operation<void, unknown> {
  try {
    for (const chunk of yield* each(yield* Codec.actions.encodeStream(source))) {
      connection.publish(subject, chunk)

      yield* each.next()
    }

    connection.publish(subject, EMPTY, { headers: endHeaders() })
  } catch (error) {
    const payload = yield* Codec.actions.encode(failureToPayload(asFailure(error)))
    connection.publish(subject, payload, { headers: errorHeaders() })
  }
}

export const subscribeFromNats = function* (
  sub: NatsSubscription,
  hostScope?: Scope,
): Operation<Stream<unknown, true | Result.Failure<unknown>>, unknown> {
  const raw = createChannel<Uint8Array, true | Result.Failure<unknown>>()

  const reader = function* () {
    try {
      const natsStream = into<Msg>(sub as AsyncIterable<Msg>)

      for (const msg of yield* each(natsStream)) {
        const event = msg.headers?.get(STREAM_EVENT)

        if (event === EVENT_END) {
          yield* raw.close(true)
          return
        }

        if (event === EVENT_ERROR) {
          const payload = (yield* Codec.actions.decode(msg.data)) as Nats.StreamErrorPayload
          yield* raw.close(failureFromPayload(payload))
          return
        }

        yield* raw.send(msg.data)

        yield* each.next()
      }
    } finally {
      yield* raw.close(true)
      if (!sub.isClosed()) {
        sub.unsubscribe()
      }
    }
  }

  if (hostScope) {
    hostScope.run(reader)
  } else {
    yield* spawn(reader)
  }

  return yield* Codec.actions.decodeStream(raw)
}
