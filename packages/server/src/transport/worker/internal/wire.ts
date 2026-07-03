import { Codec } from 'std:codec'
import { operation } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'
import { serializeError } from 'std:shared'

import { JsonCodec } from 'std:codec/impl/json'

import type { WorkerDef } from '../types'

const PLAIN_PROTO: unknown = Object.getPrototypeOf({})

/**
 * Preserve the structured error VALUE across the wire so a non-string error tag survives the hop
 * (the legacy `serializeError` flattens it to a string, destroying `error.code` / object-tag /
 * predicate matching). Returns `{ keep: false }` for values that are not safe to structured-clone
 * or codec-encode (class instances with methods, functions, symbols) so the receiver falls back to
 * the string `error`. `Error` instances are reduced to a plain `{ name, message, code? }` because a
 * real `Error` cannot be reconstructed across processes anyway, but its `code` must not be lost.
 */
const structuredError = (error: unknown): { keep: boolean; value: unknown } => {
  if (error === null) {
    return { keep: true, value: null }
  }
  const t = typeof error
  if (t === 'string' || t === 'number' || t === 'boolean' || t === 'bigint') {
    return { keep: true, value: error }
  }
  if (error instanceof Error) {
    const code = (error as AnyType).code
    return {
      keep: true,
      value: { name: error.name, message: error.message, ...(code === undefined ? {} : { code }) },
    }
  }
  if (t === 'object') {
    const proto: unknown = Object.getPrototypeOf(error)
    if (proto === PLAIN_PROTO || proto === null || Array.isArray(error)) {
      return { keep: true, value: error }
    }
  }
  return { keep: false, value: undefined }
}

// reconstruct the failure error tag from the structured `errorValue` when the producer preserved
// it; older peers omit it, so fall back to the flattened string `error` (back-compat).
const wireErrorTag = (wire: { error: string; errorValue?: unknown }): unknown =>
  'errorValue' in wire ? wire.errorValue : wire.error

export const wireSuccess = (value: unknown): WorkerDef.WireSuccess => ({ _t: '__success__', value })

export const wireFailure = (failure: Result.Failure<unknown>): WorkerDef.WireFailure => {
  const structured = structuredError(failure.error)
  return {
    _t: '__failure__',
    error: serializeError(failure.error),
    message: failure.message,
    causes: failure.causes,
    ...(structured.keep ? { errorValue: structured.value } : {}),
  }
}

export const wireStream = (): WorkerDef.WireStream => ({ _t: '__stream__' })

export const unwrapWire = operation(function* (wire: WorkerDef.Wire) {
  if (wire._t === '__failure__') {
    return yield* fail(wireErrorTag(wire), wire.message, ...(wire.causes ?? []))
  }
  if (wire._t === '__stream__') {
    return yield* fail('server:core.transport-dispatch', 'unexpected stream wire in unwrapWire')
  }
  return wire.value
})

export const failureFromPayload = (
  payload: WorkerDef.StreamErrorPayload,
): Result.Failure<unknown> =>
  fail(wireErrorTag(payload), payload.message, ...(payload.causes ?? [])) as Result.Failure<unknown>

export const failureToPayload = (
  failure: Result.Failure<unknown>,
): WorkerDef.StreamErrorPayload => {
  const structured = structuredError(failure.error)
  return {
    error: serializeError(failure.error),
    message: failure.message,
    causes: failure.causes,
    ...(structured.keep ? { errorValue: structured.value } : {}),
  }
}

export const encodeValue = operation(function* (mode: WorkerDef.WireMode, value: unknown) {
  return mode === 'codec' ? yield* Codec.actions.encode(value) : value
})

export const decodeValue = operation(function* (mode: WorkerDef.WireMode, data: unknown) {
  return mode === 'codec' ? yield* JsonCodec.actions.decode(data as Uint8Array) : data
})
