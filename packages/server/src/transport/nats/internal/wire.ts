import { operation } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import type { Nats } from '../types'

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

export const wireSuccess = (value: unknown): Nats.WireSuccess => ({ _t: '__success__', value })

export const wireFailure = (failure: Result.Failure<unknown>): Nats.WireFailure => ({
  _t: '__failure__',
  error: serializeError(failure.error),
  message: failure.message,
  causes: failure.causes,
})

export const wireStream = (): Nats.WireStream => ({ _t: '__stream__' })

export const unwrapWire = operation(function* (wire: Nats.Wire) {
  if (wire._t === '__failure__') {
    return yield* fail(wire.error, wire.message, ...(wire.causes ?? []))
  }
  if (wire._t === '__stream__') {
    return yield* fail('server:core.transport-dispatch', 'unexpected stream wire in unwrapWire')
  }
  return wire.value
})
