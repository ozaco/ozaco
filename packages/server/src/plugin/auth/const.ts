/** Every token kind a strategy mints — `type` is embedded in the JWT payload and checked on verify. */
export const TOKEN_TYPES = ['access', 'refresh', 'session'] as const

/** The `authorization` scheme prefix strategies parse (the gateway promotes `?token=` into it). */
export const BEARER_PREFIX = 'Bearer '

/** Subject prefix for service-to-service principals minted by `signServiceToken`. */
export const SERVICE_SUB_PREFIX = 'service:'

/** Default session token lifetime — 7 days. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** Default access token lifetime — 15 minutes. */
export const ACCESS_TTL_MS = 15 * 60 * 1000

/** Default refresh token lifetime — 7 days. */
export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000
