import type { Result } from 'std:result'
import { fail } from 'std:result'
import type { AnyType } from 'std:shared'

import { NatsErrors } from '../errors'

// No `'503'` (no-responders) entry: JetStream answers a missing consumer differently — a publish to
// a subject no stream covers errors immediately, and `hosts()` asks `consumers.info` BEFORE anything
// is sent, so "nobody serves this" is a routing answer here, not a request failure to interpret.
const CODE_TO_TAG: Record<string, string> = {
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

const isNatsErrorLike = (
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

  // A bare "503" is the client's no-responders code and explains nothing on its own — say what it
  // usually means instead of forwarding the number.
  const message =
    error.code === '503'
      ? 'no responders on the subject (NATS 503) — for a JetStream API call this means the server runs without -js'
      : (error.message ?? '')

  return fail(tag, message, ...failure.causes) as Result.Failure<unknown>
}
