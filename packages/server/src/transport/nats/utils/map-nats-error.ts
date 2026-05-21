import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { NatsError } from 'nats'

import { NatsErrors } from '../errors'

const CODE_TO_TAG: Record<string, string> = {
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

export const mapNatsFailure = <E>(failure: Result.Failure<E>): Result.Failure<unknown> => {
  const error = failure.error

  if (!(error instanceof NatsError)) {
    return failure
  }

  const code = (error as AnyType).code as string | undefined
  const tag = (code && CODE_TO_TAG[code]) ?? NatsErrors.Unknown

  return fail(tag, error.message ?? '', ...failure.causes) as Result.Failure<unknown>
}
