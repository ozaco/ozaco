import { createTags } from 'std:shared'

/** The failure tags the Auth plugin raises besides the server's own. jose's verification errors
 * are classified by their `code` (`asFailure(error, AuthErrors)`): an expired JWT is
 * `expired-token`, every other reason a JWT is "not mine" (malformed, another key, a failed claim,
 * a foreign alg) `invalid-token`. */
export const AuthErrors = createTags(
  'server:auth',

  [
    'invalid-token',
    {
      code: [
        'ERR_JWS_INVALID',
        'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
        'ERR_JWT_INVALID',
        'ERR_JWT_CLAIM_VALIDATION_FAILED',
        'ERR_JOSE_ALG_NOT_ALLOWED',
        'ERR_JOSE_NOT_SUPPORTED',
      ],
    },
  ],
  ['expired-token', { code: 'ERR_JWT_EXPIRED' }],
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
