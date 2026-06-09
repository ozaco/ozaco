import { Codec } from 'std:codec'
import { operation } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { WorkerDef } from '../types'

export const serializeError = (error: unknown): string => {
  if (typeof error === 'string') {
    return error
  }
  if (error instanceof Error) {
    const code = (error as AnyType).code
    return code
      ? `${error.name}: ${error.message} (${String(code)})`
      : `${error.name}: ${error.message}`
  }
  if (error === null || error === undefined) {
    return String(error)
  }
  if (typeof error === 'object') {
    try {
      return JSON.stringify(error)
    } catch {
      return Object.prototype.toString.call(error)
    }
  }
  return String(error)
}

export const wireSuccess = (value: unknown): WorkerDef.WireSuccess => ({ _t: '__success__', value })

export const wireFailure = (failure: Result.Failure<unknown>): WorkerDef.WireFailure => ({
  _t: '__failure__',
  error: serializeError(failure.error),
  message: failure.message,
  causes: failure.causes,
})

export const wireStream = (): WorkerDef.WireStream => ({ _t: '__stream__' })

export const unwrapWire = operation(function* (wire: WorkerDef.Wire) {
  if (wire._t === '__failure__') {
    return yield* fail(wire.error, wire.message, ...(wire.causes ?? []))
  }
  if (wire._t === '__stream__') {
    return yield* fail('server:core.transport-dispatch', 'unexpected stream wire in unwrapWire')
  }
  return wire.value
})

export const failureFromPayload = (
  payload: WorkerDef.StreamErrorPayload,
): Result.Failure<unknown> =>
  fail(payload.error, payload.message, ...(payload.causes ?? [])) as Result.Failure<unknown>

export const failureToPayload = (
  failure: Result.Failure<unknown>,
): WorkerDef.StreamErrorPayload => ({
  error: serializeError(failure.error),
  message: failure.message,
  causes: failure.causes,
})

export const encodeValue = operation(function* (mode: WorkerDef.WireMode, value: unknown) {
  return mode === 'codec' ? yield* Codec.actions.encode(value) : value
})

export const decodeValue = operation(function* (mode: WorkerDef.WireMode, data: unknown) {
  return mode === 'codec' ? yield* Codec.actions.decode(data as Uint8Array) : data
})
