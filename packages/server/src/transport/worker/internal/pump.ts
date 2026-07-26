import type { Source } from 'server:core'
import { Codec } from 'std:codec'
import type { Operation, Stream } from 'std:effect'
import type { Result } from 'std:result'
import { asFailure, fail, isFailure } from 'std:result'

import type { PumpOutcome } from '../../shared/types'
import type { WorkerDef } from '../types'

import { failureToPayload } from './wire'

/**
 * Drain a lane onto an endpoint sid.
 *
 * Iterated BY HAND, because the close value is half the protocol: a source that closes with a
 * failure (an upload socket that died mid-body) must become the sid's `error` frame, never a clean
 * `end` — an `end` here is the receiver treating a truncated feed as a complete one.
 */
export const pumpStream = function* (
  endpoint: WorkerDef.Endpoint,
  sid: string,
  source: Stream<unknown, unknown>,
): Operation<void> {
  let outcome: PumpOutcome

  try {
    const chunks = endpoint.wire === 'codec' ? yield* Codec.actions.encodeStream(source) : source
    const subscription = yield* chunks
    while (true) {
      const next = yield* subscription.next()
      if (next.done) {
        outcome = isFailure(next.value) ? next.value : 'end'
        break
      }
      endpoint.post({ kind: 'chunk', sid, data: next.value })
    }
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

/**
 * Drain a multipart body onto one sid, parts framed in wire order — the worker-plane mirror of the
 * NATS parts lane. Field and file-open metadata travel as their own envelopes; a file's bytes are
 * plain `chunk` frames between `part-file` and `part-file-end`, raw in both wire modes (a part is
 * bytes, always — no codec applies).
 */
export const pumpPartsStream = function* (
  endpoint: WorkerDef.Endpoint,
  sid: string,
  parts: Stream<Source.Part, unknown>,
): Operation<void> {
  let outcome: PumpOutcome

  try {
    const subscription = yield* parts
    while (true) {
      const next = yield* subscription.next()
      if (next.done) {
        outcome = isFailure(next.value) ? next.value : 'end'
        break
      }

      const part = next.value
      if (part.kind === 'field') {
        endpoint.post({ kind: 'part-field', sid, name: part.name, value: part.value })
      } else {
        endpoint.post({
          kind: 'part-file',
          sid,
          name: part.name,
          ...(part.filename === undefined ? {} : { filename: part.filename }),
          ...(part.mediaType === undefined ? {} : { mediaType: part.mediaType }),
        })

        const file = yield* part.stream
        while (true) {
          const chunk = yield* file.next()
          if (chunk.done) {
            if (isFailure(chunk.value)) {
              throw chunk.value
            }
            break
          }
          endpoint.post({ kind: 'chunk', sid, data: chunk.value })
        }

        endpoint.post({ kind: 'part-file-end', sid })
      }
    }
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
