import { createTags } from 'std:shared'

/** The failure tags the Auth plugin raises besides the server's own. */
export const AuthErrors = createTags(
  'server:auth',

  'invalid-token',
  'expired-token',
  'replayed',
  'bad-credentials',
)

/** The cause names Auth appends to the server's Unauthorized/Forbidden failures. */
export const AuthCauses = createTags(
  'server:auth',

  'missing',
  'service-token',
  'user-token',
  'predicate',
  'permission',
  'role',
  'first-frame',
)
