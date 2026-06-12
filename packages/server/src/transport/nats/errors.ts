import { createTags } from 'std:shared'

export const NatsErrors = createTags(
  'server:nats-transport',

  'no-responders',
  'timeout',
  'request-error',

  'connection-closed',
  'connection-draining',
  'connection-refused',
  'connection-timeout',
  'disconnect',

  'authorization-violation',
  'authentication-expired',
  'authentication-timeout',
  'permissions-violation',

  'protocol-error',
  'bad-subject',
  'bad-header',
  'bad-payload',
  'max-payload-exceeded',
  'invalid-payload',

  'subscription-closed',
  'subscription-draining',

  'unknown',
)
