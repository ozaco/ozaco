import { createTags } from 'std:shared'

export const ServerErrorCode = createTags(
  null,
  'validation',
  'forbidden',
  'not-found',
  'unauthorized',
  'exists',
  'unexpected',
  'server-internal',
  'server-paused',
  'payload-too-large',
  'missing-settings',
  'protocol-not-cloneable',
)
