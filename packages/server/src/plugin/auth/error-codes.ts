import { createTags } from 'std:shared'

export const AuthErrorCode = createTags(
  null,
  'invalid-credentials',
  'invalid-token',
  'expired-token',
  'revoked-token',
  'reused-token',
  'missing-token',
  'not-provided',
  'unknown-provider',
  'verification-consumed',
  'invalid-duration',
  'invalid-state',
)
