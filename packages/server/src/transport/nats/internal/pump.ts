import { Codec } from 'std:codec'
import type { Operation, Scope, Stream } from 'std:effect'
import { streamForEach } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'

import type { NatsConnection } from 'nats'

import type { PumpOutcome } from '../../shared/types'
import { EMPTY_PAYLOAD } from '../const'

import { endHeaders, errorHeaders, failureToPayload } from './wire'

export const pumpToNats = function* (
  connection: NatsConnection,
  subject: string,
  source: Stream<unknown, unknown>,
): Operation<void> {
  let outcome: PumpOutcome

  try {
    yield* streamForEach(yield* Codec.actions.encodeStream(source), chunk =>
      connection.publish(subject, chunk),
    )
    outcome = 'end'
  } catch (error) {
    outcome = asFailure(error)
  } finally {
    try {
      if (outcome === 'end') {
        connection.publish(subject, EMPTY_PAYLOAD, { headers: endHeaders() })
      } else {
        const failure = outcome ?? (fail('cancelled', 'pump halted') as Result.Failure<unknown>)
        const payload = yield* Codec.actions.encode(failureToPayload(failure))
        connection.publish(subject, payload, { headers: errorHeaders() })
      }
    } catch {
      /* connection may already be torn down */
    }
  }
}

export const pumpInputStreams = (
  target: { connection: NatsConnection; scope: Scope },
  inputSubjects: readonly string[],
  streams: readonly Stream<unknown, unknown>[],
): void => {
  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i]!
    const subjectName = inputSubjects[i]!

    target.scope.run(function* () {
      try {
        yield* pumpToNats(target.connection, subjectName, stream)
      } catch {
        /* input pump errors swallowed — receiver sees end/error */
      }
    })
  }
}
