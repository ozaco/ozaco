import { Codec } from 'std:codec'
import { operation } from 'std:effect'
import type { Result } from 'std:result'
import { appendCauses, fail } from 'std:result'

import { CoreErrors } from '../errors'
import type { Meta } from '../types/common'
import type { Wire } from '../types/wire'

const HALTED = 'halted'

export const isHaltedFailure = (failure: Result.Failure<unknown>): boolean =>
  String(failure.error) === HALTED

/** Full-fidelity failure → wire: tag, message, EVERY cause, halt flag, status, meta. */
export const toWireFailure = (
  failure: Result.Failure<unknown>,
  extra?: { status?: number | undefined; meta?: Meta | undefined },
): Wire.Failure => ({
  error: String(failure.error),
  message: failure.message,
  causes: [...failure.causes],
  halted: isHaltedFailure(failure) ? true : undefined,
  status: extra?.status,
  meta: extra?.meta,
})

/** Wire → a real Result failure, cause chain intact — `yield*` it to re-raise. */
export const fromWireFailure = (wire: Wire.Failure): Result.Failure<string> => {
  const failure = fail(wire.error, wire.message) as unknown as Result.Failure<string>

  appendCauses(failure, ...wire.causes)

  return failure
}

/**
 * The ONE envelope codec every carrier shares (JsonCodec baseline via the routed std codec).
 * Note: `lane` envelopes carrying raw bytes are framed by the carrier itself (headers/ports) —
 * this codec is for the structured envelopes.
 */
export const encodeEnvelope = operation(function* (envelope: Wire.Envelope) {
  return yield* Codec.actions.encode(envelope)
})

export const decodeEnvelope = operation(function* (data: Uint8Array) {
  const decoded = yield* Codec.actions.decode<Wire.Envelope>(data)

  if (!decoded || typeof decoded !== 'object' || typeof decoded.k !== 'string') {
    return yield* fail(CoreErrors.BadRequest, 'malformed wire envelope')
  }

  return decoded
})
