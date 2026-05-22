import type { TransportDef } from 'server:core'
import { useContext } from 'std:effect'
import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { NatsTransport } from './definition'
import { NatsErrors } from './errors'
import type { Nats } from './types'

export const getSelf = (): TransportDef => NatsTransport

export const useNatsContext = function* () {
  const ctx = yield* useContext(getSelf())
  return ctx as unknown as Nats.Context
}

export const CODE_TO_TAG: Record<string, string> = {
  '503': NatsErrors.NoResponders,
  TIMEOUT: NatsErrors.Timeout,
  REQUEST_ERROR: NatsErrors.RequestError,

  CONNECTION_CLOSED: NatsErrors.ConnectionClosed,
  CONNECTION_DRAINING: NatsErrors.ConnectionDraining,
  CONNECTION_REFUSED: NatsErrors.ConnectionRefused,
  CONNECTION_TIMEOUT: NatsErrors.ConnectionTimeout,
  DISCONNECT: NatsErrors.Disconnect,

  AUTHORIZATION_VIOLATION: NatsErrors.AuthorizationViolation,
  AUTHENTICATION_EXPIRED: NatsErrors.AuthenticationExpired,
  AUTHENTICATION_TIMEOUT: NatsErrors.AuthenticationTimeout,
  PERMISSIONS_VIOLATION: NatsErrors.PermissionsViolation,

  NATS_PROTOCOL_ERR: NatsErrors.ProtocolError,
  BAD_SUBJECT: NatsErrors.BadSubject,
  BAD_HEADER: NatsErrors.BadHeader,
  BAD_PAYLOAD: NatsErrors.BadPayload,
  MAX_PAYLOAD_EXCEEDED: NatsErrors.MaxPayloadExceeded,
  INVALID_PAYLOAD: NatsErrors.InvalidPayload,

  SUB_CLOSED: NatsErrors.SubscriptionClosed,
  SUB_DRAINING: NatsErrors.SubscriptionDraining,
}

export const isNatsErrorLike = (
  error: unknown,
): error is { name: string; code: string; message: string } =>
  error !== null &&
  typeof error === 'object' &&
  (error as AnyType).name === 'NatsError' &&
  typeof (error as AnyType).code === 'string'

export const mapNatsFailure = <E>(failure: Result.Failure<E>): Result.Failure<unknown> => {
  const error = failure.error

  if (!isNatsErrorLike(error)) {
    return failure
  }

  const tag = CODE_TO_TAG[error.code] ?? NatsErrors.Unknown

  return fail(tag, error.message ?? '', ...failure.causes) as Result.Failure<unknown>
}
