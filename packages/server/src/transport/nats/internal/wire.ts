import type { Outcome, Response, Source } from 'server:core'
import { DataType } from 'server:core'
import { Codec } from 'std:codec'
import { operation } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import { serializeError } from 'std:shared'

import type { MsgHdrs } from 'nats'
import { headers as createHeaders } from 'nats'

import { LANE_BINARY, LANE_ENCODING, LANE_END, LANE_ERROR, LANE_EVENT, LANE_PART } from '../const'
import type { Nats } from '../types'

export const wireSuccess = (response: Response): Nats.WireSuccess => ({
  _t: '__success__',
  value: (response.sources.find(source => source.type === DataType.normal) as Source.Normal)?.value,
  ...(response.status === undefined ? {} : { status: response.status }),
  ...(Object.keys(response.meta).length === 0 ? {} : { meta: response.meta }),
})

/**
 * Put a failure on the wire, keeping the FAULT rather than flattening it.
 *
 * `serializeError` on a fault object yields its inspection, not its tag — so an owner's
 * `unauthorized` crossed as gibberish and every surface on the far side mapped it to 500. The tag,
 * the halt reason and whatever status the handler had already set each get their own field.
 */
export const wireFailure = (failure: Result.Failure<unknown>): Nats.WireFailure => {
  const fault = failure.error as Outcome.Fault | undefined
  const isFault = typeof fault?.tag === 'string'

  return {
    _t: '__failure__',
    error: isFault ? fault.tag : serializeError(failure.error),
    message: failure.message,
    causes: failure.causes,
    ...(isFault && fault.halted !== undefined ? { halted: fault.halted } : {}),
    ...(isFault && fault.response?.status !== undefined ? { status: fault.response.status } : {}),
    ...(isFault && fault.response?.meta !== undefined ? { meta: fault.response.meta } : {}),
  }
}

export const wireStream = (response: Response): Nats.WireStream => ({
  _t: '__stream__',
  ...(response.status === undefined ? {} : { status: response.status }),
  ...(Object.keys(response.meta).length === 0 ? {} : { meta: response.meta }),
})

export const unwrapWire = operation(function* (wire: Nats.Wire) {
  if (wire._t === '__failure__') {
    // Rebuilt as a FAULT, so `isFault` and the status mapping behave the same either side of a wire.
    const fault: Outcome.Fault = {
      tag: wire.error,
      ...(wire.halted === undefined ? {} : { halted: wire.halted as Outcome.Halt }),
      ...(wire.status === undefined && wire.meta === undefined
        ? {}
        : { response: { status: wire.status, meta: wire.meta ?? {}, sources: [] } }),
    }

    return yield* fail(fault, wire.message, ...(wire.causes ?? []))
  }
  if (wire._t === '__stream__') {
    return yield* fail('server:core.transport-dispatch', 'unexpected stream wire in unwrapWire')
  }
  return wire.value
})

export const encodeReply = operation(function* (wire: Nats.Wire) {
  // the fallback encode is itself fallible, so this stays a try/catch (recover's handler must be
  // infallible); everything else in this file's callers moved to attempt/mapError
  try {
    return yield* Codec.actions.encode(wire)
  } catch (error) {
    return yield* Codec.actions.encode({
      _t: '__failure__',
      error: 'server:core.codec-encode',
      message: 'failed to encode response',
      causes: [String(error)],
    } satisfies Nats.Wire)
  }
})

export const endHeaders = (): MsgHdrs => {
  const h = createHeaders()
  h.set(LANE_EVENT, LANE_END)
  return h
}

export const errorHeaders = (): MsgHdrs => {
  const h = createHeaders()
  h.set(LANE_EVENT, LANE_ERROR)
  return h
}

/** The encoding travels ON the message, set from the WRITER's declaration — the reader never
 * guesses whether a payload is raw bytes or a codec value. Value messages carry no header. */
export const binaryHeaders = (): MsgHdrs => {
  const h = createHeaders()
  h.set(LANE_ENCODING, LANE_BINARY)
  return h
}

export const partHeaders = (kind: string): MsgHdrs => {
  const h = createHeaders()
  h.set(LANE_PART, kind)
  return h
}

export const failureFromPayload = (payload: Nats.StreamErrorPayload): Result.Failure<unknown> =>
  fail(payload.error, payload.message, ...(payload.causes ?? [])) as Result.Failure<unknown>

export const failureToPayload = (failure: Result.Failure<unknown>): Nats.StreamErrorPayload => ({
  error: serializeError(failure.error),
  message: failure.message,
  causes: failure.causes,
})
