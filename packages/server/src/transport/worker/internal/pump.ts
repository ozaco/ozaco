import { Codec } from 'std:codec'
import type { Operation, Stream } from 'std:effect'
import { streamForEach } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail } from 'std:result'

import type { PumpOutcome } from '../../shared/types'
import type { WorkerDef } from '../types'

import { failureToPayload } from './wire'

export const pumpStream = function* (
  endpoint: WorkerDef.Endpoint,
  sid: string,
  source: Stream<unknown, unknown>,
): Operation<void, unknown> {
  let outcome: PumpOutcome

  try {
    const chunks = endpoint.wire === 'codec' ? yield* Codec.actions.encodeStream(source) : source
    yield* streamForEach(chunks, data => endpoint.post({ kind: 'chunk', sid, data }))
    outcome = 'end'
  } catch (error) {
    outcome = asFailure(error)
  } finally {
    if (outcome === 'end') {
      endpoint.post({ kind: 'end', sid })
    } else {
      const failure = outcome ?? (fail('cancelled', 'pump halted') as Result.Failure<unknown>)
      endpoint.post({ kind: 'error', sid, failure: failureToPayload(failure) })
    }
  }
}
