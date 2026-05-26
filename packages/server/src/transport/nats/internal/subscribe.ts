import { Codec } from 'server:core'
import type { Operation, Scope, Stream } from 'std:effect'
import { createChannel, each, into, spawn } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'

import type { Msg, Subscription as NatsSubscription } from 'nats'

import { STREAM_EVENT, STREAM_EVENT_END, STREAM_EVENT_ERROR } from '../const'
import type { Nats } from '../types'

import { useNatsContext } from './context'
import { failureFromPayload } from './wire'

export const subscribeFromNats = function* (
  sub: NatsSubscription,
  hostScope?: Scope,
): Operation<Stream<unknown, true | Result.Failure<unknown>>, unknown> {
  const raw = createChannel<Uint8Array, true | Result.Failure<unknown>>()

  const reader = function* () {
    let closed = false
    try {
      const natsStream = into<Msg>(sub as AsyncIterable<Msg>)

      for (const msg of yield* each(natsStream)) {
        const event = msg.headers?.get(STREAM_EVENT)

        if (event === STREAM_EVENT_END) {
          yield* raw.close(true)
          closed = true
          return
        }

        if (event === STREAM_EVENT_ERROR) {
          const payload = (yield* Codec.actions.decode(msg.data)) as Nats.StreamErrorPayload
          yield* raw.close(failureFromPayload(payload))
          closed = true
          return
        }

        yield* raw.send(msg.data)

        yield* each.next()
      }
    } finally {
      if (!closed) {
        yield* raw.close(asFailure(fail('cancelled', 'reader halted')))
      }

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

export const captureInputStreams = function* (inputSubjects: readonly string[]) {
  const nats = yield* useNatsContext()
  const streams: Stream<unknown, void>[] = []
  const subs: { unsubscribe: () => void; isClosed: () => boolean }[] = []

  for (const subject of inputSubjects) {
    const sub = nats.connection.subscribe(subject)
    subs.push(sub)
    const stream = yield* subscribeFromNats(sub, nats.scope)
    streams.push(stream as Stream<unknown, void>)
  }

  return { streams, subs }
}
