import { createTags } from 'std:shared'

/**
 * Precise auth failure tags. HTTP-facing failures use `CoreErrors.Unauthorized`/`Forbidden` as the
 * TAG (so the edge maps 401/403 automatically) and carry one of these in the CAUSES for exactness;
 * setup-time failures (`not-configured`, `invalid-key`) use them as the tag directly.
 */
export const AuthErrors = createTags(
  'server:auth',
  'invalid-credentials',
  'invalid-token',
  'expired-token',
  'reused-token',
  'not-configured',
  'invalid-key',
)
